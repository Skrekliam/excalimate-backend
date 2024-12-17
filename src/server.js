const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const { PuppeteerScreenRecorder } = require("puppeteer-screen-recorder");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const winston = require("winston");
require("dotenv").config();

// Configure logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
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

const UI_APP_URL = process.env.UI_APP_URL;

const app = express();
app.use(express.json({ limit: "50mb" }));

const tempDir = path.join(__dirname, "temp");
fs.ensureDirSync(tempDir);

app.post("/export", async (req, res) => {
  const {
    format = "mp4",
    renderData,
    wait = 1000,
    duration = 1000,
    fps = 60,
  } = req.body;

  if (duration > process.env.MAX_TIME_TO_RECORD) {
    res.status(400).send("Duration is too long");
  }

  logger.info("Starting export process", { format, wait, duration, fps });

  try {
    const exportId = Date.now().toString();
    const exportDir = path.join(tempDir, exportId);
    fs.ensureDirSync(exportDir);
    logger.debug("Created export directory", { exportDir });

    const url = `${UI_APP_URL}/render?wait=${wait}#${renderData}`;

    const outputPathMP4 = path.join(exportDir, `output.mp4`);
    const outputPathGIF = path.join(exportDir, `output.gif`);
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 2,
      });
      logger.debug("Browser page initialized");

      const recorder = new PuppeteerScreenRecorder(page, { fps });

      await page.goto(url);
      logger.info("Navigation complete");

      await recorder.start(outputPathMP4);
      await new Promise((r) => setTimeout(r, duration));
      await recorder.stop();
      logger.info("Recording completed", { outputPathMP4 });

      if (format === "gif") {
        logger.info("Starting GIF conversion");
        await exec(
          `ffmpeg -i ${outputPathMP4} -r ${fps} -qscale 0 ${outputPathGIF}`
        );
        logger.info("GIF conversion completed", { outputPathGIF });
      }
    } catch (e) {
      logger.error("Error during recording", {
        error: e.message,
        stack: e.stack,
      });
      throw e;
    } finally {
      await browser.close();
      logger.debug("Browser closed");
    }

    res.sendFile(
      format === "gif" ? outputPathGIF : outputPathMP4,
      async (err) => {
        if (err) {
          logger.error("Error sending file", { error: err.message });
        }
        await fs.remove(exportDir);
        logger.debug("Cleaned up export directory", { exportDir });
      }
    );
  } catch (error) {
    logger.error("Export failed", { error: error.message, stack: error.stack });
    res.status(500).json({ error: "Export failed" });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
