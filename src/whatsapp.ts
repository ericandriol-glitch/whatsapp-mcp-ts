import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";
import fs from "node:fs";
import open from "open";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  storeContact,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");
const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

// Map a media mimetype to a sensible file extension.
function extForMime(mimetype: string | null | undefined, fallback: string): string {
  if (!mimetype) return fallback;
  const base = mimetype.split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
  };
  if (map[base]) return map[base];
  const guess = base.split("/")[1];
  return guess ? guess.replace(/[^a-z0-9]/gi, "") || fallback : fallback;
}

// Detect a downloadable media payload on a message. Returns null for text-only.
function getDownloadableMedia(
  msg: WAMessage,
): { kind: string; ext: string } | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return { kind: "image", ext: extForMime(m.imageMessage.mimetype, "jpg") };
  if (m.videoMessage) return { kind: "video", ext: extForMime(m.videoMessage.mimetype, "mp4") };
  if (m.stickerMessage) return { kind: "sticker", ext: extForMime(m.stickerMessage.mimetype, "webp") };
  if (m.documentMessage) {
    const fileName = m.documentMessage.fileName ?? "";
    const dotExt = fileName.includes(".") ? fileName.split(".").pop()! : "";
    return { kind: "document", ext: (dotExt || extForMime(m.documentMessage.mimetype, "bin")).toLowerCase() };
  }
  if (m.audioMessage) return { kind: "audio", ext: extForMime(m.audioMessage.mimetype, "ogg") };
  return null;
}

function sanitizeForPath(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]/g, "_");
}

// Download a message's media to data/media/<chat>/<id>.<ext>. Returns the path
// relative to data/ (e.g. "media/<chat>/<id>.jpg"), or null on any failure.
// Never throws — media is best-effort and must not block text storage.
async function downloadMediaForMessage(
  sock: WhatsAppSocket,
  msg: WAMessage,
  logger: P.Logger,
): Promise<string | null> {
  try {
    const media = getDownloadableMedia(msg);
    if (!media) return null;
    const chat = sanitizeForPath(msg.key.remoteJid ?? "unknown");
    const id = sanitizeForPath(msg.key.id ?? `${Date.now()}`);
    const relPath = path.join("media", chat, `${id}.${media.ext}`);
    const absPath = path.join(DATA_DIR, relPath);

    // Skip if already downloaded (idempotent on re-delivery).
    if (fs.existsSync(absPath)) return relPath;

    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    )) as Buffer;

    if (!buffer || buffer.length === 0) return null;

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buffer);
    logger.info({ kind: media.kind, relPath, bytes: buffer.length }, "Downloaded media");
    return relPath;
  } catch (err) {
    logger.warn({ err, msgId: msg.key?.id }, "Media download failed (storing text only)");
    return null;
  }
}

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage) {
    // Store every image, with or without a caption, so media can be attached.
    const cap = msg.message.imageMessage.caption;
    content = cap ? `[Image] ${cap}` : `[Image]`;
  } else if (msg.message.videoMessage) {
    const cap = msg.message.videoMessage.caption;
    content = cap ? `[Video] ${cap}` : `[Video]`;
  } else if (msg.message.documentMessage) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`.trimEnd();
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage) {
    // Capture coordinates so a bare map pin is still resolvable later.
    const loc = msg.message.locationMessage;
    const label = loc.name || loc.address || "";
    const coords =
      loc.degreesLatitude != null && loc.degreesLongitude != null
        ? ` (${loc.degreesLatitude},${loc.degreesLongitude})`
        : "";
    content = `[Location] ${label}${coords}`.trimEnd();
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false,   // prevent suppressing phone push notifications
    syncFullHistory: false,       // partial sync only — reduces ban risk
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          { qrCodeData: qr },
          "QR Code Received. Copy the qrCodeData string and use a QR code generator (e.g., online website) to display and scan it with your WhatsApp app."
        );
        // for now we roughly open the QR code in a browser
        await open(`https://quickchart.io/qr?text=${encodeURIComponent(qr)}`);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        // console.log("Logged as", sock.user?.name);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      // Media download on the history path is OPT-IN (BACKFILL_MEDIA=1) so normal
      // startup stays light and low-ban-risk. When enabled, any media that
      // WhatsApp re-delivers during a history/on-demand sync gets pulled too.
      const backfillMedia = process.env.BACKFILL_MEDIA === "1";
      let storedCount = 0;
      for (const msg of messages) {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          if (backfillMedia) {
            parsed.media_path = await downloadMediaForMessage(sock, msg, logger);
          }
          storeMessage(parsed);
          storedCount++;
        }
      }
      logger.info(
        { backfillMedia },
        `Stored ${storedCount} messages from history sync.`,
      );
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            // Best-effort media download for live messages only (not bulk history).
            // Failure returns null and never blocks storing the text record.
            parsed.media_path = await downloadMediaForMessage(sock, msg, logger);
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
                contentLen: parsed.content.length,
                media: parsed.media_path ?? undefined,
              },
              "Storing message"
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["contacts.update"]) {
      const updates = events["contacts.update"];
      logger.info({ count: updates.length }, "Received contacts.update event");
      for (const contact of updates) {
        if (contact.id && (contact.notify || (contact as any).name)) {
          storeContact({
            jid: contact.id,
            name: (contact as any).name ?? null,
            notify: contact.notify ?? null,
            phoneNumber: null,
          });
          logger.info({ jid: contact.id, notify: contact.notify }, "Updated contact name");
        }
      }
    }

    if (events["contacts.upsert"]) {
      const contacts = events["contacts.upsert"];
      logger.info({ count: contacts.length }, "Received contacts.upsert event");
      for (const contact of contacts) {
        storeContact({
          jid: contact.id,
          name: contact.name ?? null,
          notify: contact.notify ?? null,
          phoneNumber: (contact as any).phoneNumber ?? null,
        });
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return sock;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
