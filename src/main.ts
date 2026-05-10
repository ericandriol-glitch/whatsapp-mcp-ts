import { pino } from "pino";
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { initializeDatabase } from "./database.ts";
import { startWhatsAppConnection, sendWhatsAppMessage, type WhatsAppSocket } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";
import { jidNormalizedUser, isJidGroup } from "@whiskeysockets/baileys";

function loadBridgeToken(): string | null {
  const envToken = process.env.JARVIS_BRIDGE_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const path = join(homedir(), ".config", "jarvis", "bridge_token");
    const fileToken = readFileSync(path, "utf8").trim();
    return fileToken || null;
  } catch {
    return null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const BRIDGE_TOKEN = loadBridgeToken();

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || '.';
const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`)
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`)
);

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  let whatsappSocket: WhatsAppSocket | null = null;

  try {
    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

    mcpLogger.info("Attempting to connect to WhatsApp...");
    whatsappSocket = await startWhatsAppConnection(waLogger);
    mcpLogger.info("WhatsApp connection process initiated.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or WhatsApp connection attempt"
    );

    process.exit(1);
  }

  try {
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(whatsappSocket, mcpLogger, waLogger);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed to start MCP server");
    process.exit(1);
  }

  // ── Jarvis WhatsApp chat handler ──────────────────────────
  // Messages to self-chat starting with "j " or "jarvis " get forwarded
  // to the backend chat API. The response is sent back via WhatsApp.
  const BACKEND_CHAT_URL = process.env.JARVIS_BACKEND_URL || "http://localhost:8000";
  const JARVIS_PREFIXES = ["j ", "jarvis ", "jarvis, "];
  const MAX_HISTORY = 10;
  const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes — after that, start fresh
  let chatHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  let lastMessageTime = 0;

  if (whatsappSocket) {
    whatsappSocket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.key.fromMe || !msg.key.remoteJid) continue;
        if (isJidGroup(msg.key.remoteJid)) continue;

        // Only respond to self-chat.
        // WhatsApp uses either the phone JID or a LID for self-chat.
        const remoteJid = msg.key.remoteJid;
        const myJid = jidNormalizedUser(whatsappSocket!.user!.id);
        const isSelfChat =
          jidNormalizedUser(remoteJid) === myJid ||
          remoteJid === myJid ||
          (msg.key.fromMe && remoteJid.endsWith("@lid") && !msg.key.participant);
        if (!isSelfChat) continue;

        // Extract text content
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          null;
        if (!text) continue;

        // Check for Jarvis trigger prefix
        const lower = text.toLowerCase();
        const prefix = JARVIS_PREFIXES.find((p) => lower.startsWith(p));
        if (!prefix) continue;

        const userMessage = text.slice(prefix.length).trim();
        if (!userMessage) continue;

        // Handle "j clear" to reset conversation
        if (userMessage.toLowerCase() === "clear") {
          chatHistory = [];
          await sendWhatsAppMessage(waLogger, whatsappSocket, remoteJid, "Conversation cleared.");
          continue;
        }

        mcpLogger.info({ userMessage: userMessage.slice(0, 80) }, "Jarvis WhatsApp chat triggered");

        try {
          // Reset history if conversation has gone stale
          const now = Date.now();
          if (now - lastMessageTime > HISTORY_TTL_MS) {
            chatHistory = [];
          }
          lastMessageTime = now;

          // Add user message to history
          chatHistory.push({ role: "user", content: userMessage });

          // Trim to last N messages
          if (chatHistory.length > MAX_HISTORY) {
            chatHistory = chatHistory.slice(-MAX_HISTORY);
          }

          const body = JSON.stringify({
            messages: chatHistory,
            page: "dashboard",
          });

          const response = await fetch(`${BACKEND_CHAT_URL}/api/chat/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(60000),
          });

          if (!response.ok) {
            throw new Error(`Backend returned ${response.status}`);
          }

          const data = await response.json() as { text: string };
          const reply = data.text || "Sorry, I couldn't generate a response.";

          // Add assistant response to history
          chatHistory.push({ role: "assistant", content: reply });

          await sendWhatsAppMessage(waLogger, whatsappSocket, remoteJid, reply);
          mcpLogger.info("Jarvis WhatsApp reply sent");
        } catch (err: any) {
          mcpLogger.error({ err: err.message }, "Jarvis WhatsApp chat failed");
          await sendWhatsAppMessage(
            waLogger,
            whatsappSocket,
            remoteJid,
            `Jarvis error: ${err.message}`
          );
        }
      }
    });
    mcpLogger.info("Jarvis WhatsApp chat handler registered (self-chat, prefixes: j / jarvis)");
  }

  // Start HTTP API server for direct message sending (port 3001)
  const HTTP_PORT = parseInt(process.env.WA_HTTP_PORT || "3001");
  if (!BRIDGE_TOKEN) {
    mcpLogger.fatal(
      "JARVIS_BRIDGE_TOKEN is not set and ~/.config/jarvis/bridge_token is missing. " +
      "Mutating endpoints would be unauthenticated. Refusing to start HTTP server."
    );
    throw new Error("Bridge token not configured");
  }

  const isMutatingRoute = (method: string | undefined, url: string | undefined) =>
    method === "POST" && (url === "/send" || url === "/refresh-contacts");

  const authorize = (req: IncomingMessage): true | { status: number; error: string } => {
    // Reject any request carrying an Origin header — legit backend callers don't send one,
    // browsers always do. Blocks CSRF from any open tab.
    const origin = req.headers["origin"];
    if (origin) return { status: 403, error: "cross-origin requests are not allowed" };

    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return { status: 401, error: "missing bearer token" };
    }
    const presented = header.slice("Bearer ".length).trim();
    if (!constantTimeEquals(presented, BRIDGE_TOKEN)) {
      return { status: 401, error: "invalid bearer token" };
    }
    return true;
  };

  const httpServer = createServer(async (req, res) => {
    // /health is unauthenticated but non-mutating. No CORS headers — callers are loopback only.
    if (req.method === "OPTIONS") {
      // No Access-Control-Allow-* headers sent, so cross-origin preflight fails at the browser.
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", connected: !!whatsappSocket?.user }));
      return;
    }

    if (isMutatingRoute(req.method, req.url)) {
      const auth = authorize(req);
      if (auth !== true) {
        mcpLogger.warn(
          { url: req.url, origin: req.headers["origin"], reason: auth.error, remote: req.socket.remoteAddress },
          "rejected unauthorized bridge request"
        );
        res.writeHead(auth.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: auth.error }));
        return;
      }
    }

    if (req.method === "POST" && req.url === "/refresh-contacts") {
      // Force a contact name refresh by querying WhatsApp for all DM JIDs
      if (!whatsappSocket?.user) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "WhatsApp not connected" }));
        return;
      }

      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync("./data/whatsapp.db");

        // Get all DM JIDs that don't have names
        const unnamed = db.prepare(`
          SELECT c.jid FROM chats c
          LEFT JOIN contacts ct ON c.jid = ct.jid
          WHERE c.jid LIKE '%@s.whatsapp.net'
            AND (ct.notify IS NULL OR ct.notify = c.jid)
          LIMIT 200
        `).all() as Array<{ jid: string }>;

        mcpLogger.info(`Refreshing names for ${unnamed.length} contacts...`);

        let updated = 0;
        // Batch check in groups of 20
        for (let i = 0; i < unnamed.length; i += 20) {
          const batch = unnamed.slice(i, i + 20).map(r => r.jid);
          try {
            const results = await whatsappSocket.onWhatsApp(...batch);
            if (results) {
              for (const result of results) {
                if (result.exists && result.jid) {
                  // The contact's push name comes from presence/status, not onWhatsApp
                  // But onWhatsApp confirms the JID is valid
                  mcpLogger.info({ jid: result.jid }, "Confirmed WhatsApp user");
                }
              }
            }
            // Also request presence updates to trigger push name capture
            for (const jid of batch) {
              try {
                await whatsappSocket.presenceSubscribe(jid);
                updated++;
              } catch { /* some JIDs may fail */ }
            }
          } catch (err: any) {
            mcpLogger.warn({ err: err.message, batch: batch.length }, "Batch check failed");
          }
          // Small delay between batches to avoid rate limiting
          await new Promise(r => setTimeout(r, 1000));
        }

        db.close();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, checked: unnamed.length, subscribed: updated }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { recipient, message } = JSON.parse(body);
          if (!recipient || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "recipient and message required" }));
            return;
          }
          const result = await sendWhatsAppMessage(waLogger, whatsappSocket, recipient, message);
          if (result) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, messageId: result.key.id }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to send message" }));
          }
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/group-members")) {
      const url = new URL(req.url, "http://localhost");
      const jid = url.searchParams.get("jid");
      if (!jid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "jid query param required" }));
        return;
      }
      if (!whatsappSocket?.user) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "WhatsApp not connected" }));
        return;
      }
      try {
        const metadata = await whatsappSocket.groupMetadata(jid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: metadata.id,
          subject: metadata.subject,
          participants: metadata.participants.map(p => ({
            jid: p.id,
            admin: p.admin ?? null,
          })),
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    mcpLogger.info(`HTTP API server listening on http://127.0.0.1:${HTTP_PORT}`);
  });

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  waLogger.flush();
  mcpLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
