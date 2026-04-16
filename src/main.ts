import { pino } from "pino";
import { createServer } from "node:http";
import { initializeDatabase } from "./database.ts";
import { startWhatsAppConnection, sendWhatsAppMessage, type WhatsAppSocket } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";

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

  // Start HTTP API server for direct message sending (port 3001)
  const HTTP_PORT = parseInt(process.env.WA_HTTP_PORT || "3001");
  const httpServer = createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", connected: !!whatsappSocket?.user }));
      return;
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
