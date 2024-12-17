const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const { PuppeteerScreenRecorder } = require("puppeteer-screen-recorder");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const winston = require("winston");
require("dotenv").config();
const crypto = require("crypto");

// Add rate limiter configuration
const RATE_LIMIT = {
  windowMs: 60 * 1000, // 1 minute window
  maxRequests: 2, // max 10 requests per window
};

// Store IP request counts
const requestCounts = new Map();

// Rate limiter middleware
const rateLimiter = (req, res, next) => {
  const reqLogger = getLogger(req);
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  // Get or create IP entry
  let ipData = requestCounts.get(ip) || {
    count: 0,
    resetTime: now + RATE_LIMIT.windowMs,
  };

  // Reset count if window has passed
  if (now >= ipData.resetTime) {
    ipData = { count: 0, resetTime: now + RATE_LIMIT.windowMs };
  }

  // Increment count and check limit
  ipData.count++;
  requestCounts.set(ip, ipData);

  // Check if limit exceeded
  if (ipData.count > RATE_LIMIT.maxRequests) {
    reqLogger.warn("Rate limit exceeded", { count: ipData.count });
    return res.status(429).send("Too many requests");
  }

  next();
};

// Create a custom format that includes IP address
const logFormat = winston.format.printf(
  ({ level, message, timestamp, ip, ...meta }) => {
    const ipInfo = ip ? `[${ip}] ` : "";
    return `${timestamp} ${level}: ${ipInfo}${message} ${
      Object.keys(meta).length ? JSON.stringify(meta) : ""
    }`;
  }
);

// Configure logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    logFormat
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Create a wrapper function to include IP in logs
const getLogger = (req) => {
  const ip = req.ip || req.connection.remoteAddress;
  return {
    info: (message, meta = {}) => logger.info(message, { ...meta, ip }),
    error: (message, meta = {}) => logger.error(message, { ...meta, ip }),
    warn: (message, meta = {}) => logger.warn(message, { ...meta, ip }),
    debug: (message, meta = {}) => logger.debug(message, { ...meta, ip }),
  };
};

const UI_APP_URL = process.env.UI_APP_URL;

const app = express();
app.use(express.json({ limit: "50mb" }));

const tempDir = path.join(__dirname, "temp");
fs.ensureDirSync(tempDir);

// app.use("/temp", express.static(tempDir));

app.get("/", (req, res) => {
  res.send("What do you call a fake noodle? An impasta!");
});

app.post("/export", rateLimiter, async (req, res) => {
  const reqLogger = getLogger(req);
  const {
    format = "mp4",
    renderData,
    wait = 1000,
    duration = 1000,
    fps = 60,
  } = req.body;

  if (duration > process.env.MAX_TIME_TO_RECORD) {
    reqLogger.error("Duration is too long", {
      duration,
      maxTimeToRecord: process.env.MAX_TIME_TO_RECORD,
    });
    return res.status(400).send("Duration is too long");
  }

  reqLogger.info("Starting export process", { format, wait, duration, fps });

  try {
    const exportId = crypto.randomBytes(16).toString("hex");
    const exportDir = path.join(tempDir, exportId);
    fs.ensureDirSync(exportDir);
    reqLogger.debug("Created export directory", { exportDir });

    const url = `${UI_APP_URL}/render?wait=${wait}#${renderData}`;

    const outputPathMP4 = path.join(exportDir, `output.mp4`);
    const outputPathGIF = path.join(exportDir, `output.gif`);
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 2,
      });
      reqLogger.debug("Browser page initialized");

      const recorder = new PuppeteerScreenRecorder(page, { fps });

      await page.goto(url);
      reqLogger.info("Navigation complete");

      await recorder.start(outputPathMP4);
      await new Promise((r) => setTimeout(r, duration));
      await recorder.stop();
      reqLogger.info("Recording completed", { outputPathMP4 });

      if (format === "gif") {
        reqLogger.info("Starting GIF conversion");
        await exec(
          `ffmpeg -i ${outputPathMP4} -r ${fps} -qscale 0 ${outputPathGIF}`
        );
        reqLogger.info("GIF conversion completed", { outputPathGIF });
      }
    } catch (e) {
      reqLogger.error("Error during recording", {
        error: e.message,
        stack: e.stack,
      });
      throw e;
    } finally {
      await browser.close();
      reqLogger.debug("Browser closed");
    }

    res.json({
      exportId,
      expiresIn: "5 minutes", // Optional: inform client about expiration
    });

    // Set up automatic cleanup after 1 hour in case file is never downloaded
    setTimeout(async () => {
      try {
        if (await fs.pathExists(exportDir)) {
          await fs.remove(exportDir);
          reqLogger.debug("Cleaned up expired export directory", { exportDir });
        }
      } catch (error) {
        reqLogger.error("Error cleaning up expired directory", {
          error: error.message,
          exportDir,
        });
      }
    }, 5 * 60 * 1000); // 5 minutes timeout
  } catch (error) {
    reqLogger.error("Export failed", {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Export failed" });
  }
});

// Update the temp route to properly serve and then delete the file
app.get("/temp/:exportId/*", async (req, res, next) => {
  const reqLogger = getLogger(req);
  const { exportId } = req.params;
  const exportDir = path.join(tempDir, exportId);
  const filePath = path.join(tempDir, req.params.exportId, req.params[0]);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    reqLogger.error("File not found", { filePath });
    return res.status(404).send("File not found");
  }

  reqLogger.info("Starting file download", { filePath });
  reqLogger.debug("Directory to be deleted after download", {
    exportDir,
    exists: fs.existsSync(exportDir),
    contents: fs.readdirSync(exportDir),
  });

  res.download(filePath, async (err) => {
    if (err) {
      reqLogger.error("Error downloading file", { error: err.message });
      return next(err);
    }

    try {
      // Wait a brief moment to ensure file handles are closed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Use fs-extra's remove instead of removeSync
      await fs.remove(exportDir);

      // Verify deletion
      const stillExists = fs.existsSync(exportDir);
      reqLogger.info("Deletion result", {
        exportDir,
        stillExists,
        contents: stillExists ? fs.readdirSync(exportDir) : [],
      });

      if (stillExists) {
        reqLogger.warn("Directory still exists after deletion attempt");
      } else {
        reqLogger.info("Successfully deleted export directory after download", {
          exportDir,
        });
      }
    } catch (error) {
      reqLogger.error("Error cleaning up directory after download", {
        error: error.message,
        stack: error.stack,
        exportDir,
      });
    }
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
