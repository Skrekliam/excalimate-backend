const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const { PuppeteerScreenRecorder } = require("puppeteer-screen-recorder");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
require("dotenv").config();

const UI_APP_URL = process.env.UI_APP_URL;

const app = express();
app.use(express.json({ limit: "50mb" }));

const tempDir = path.join(__dirname, "temp");
fs.ensureDirSync(tempDir);

app.post("/export", async (req, res) => {
  const {
    format = "mp4",
    renderData,
    wait = 3000,
    duration = 1000,
    fps = 60,
  } = req.body;

  try {
    const exportId = Date.now().toString();
    const exportDir = path.join(tempDir, exportId);
    fs.ensureDirSync(exportDir);

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

      const recorder = new PuppeteerScreenRecorder(page, { fps });

      await page.goto(url);

      await recorder.start(outputPathMP4);
      await new Promise((r) => setTimeout(r, duration));
      await recorder.stop();

      if (format === "gif") {
        await exec(
          `ffmpeg -i ${outputPathMP4} -r ${fps} -qscale 0 ${outputPathGIF}`
        );
      }
    } catch (e) {
      console.log(e);
    } finally {
      await browser.close();
    }

    // Send the file
    res.sendFile(
      format === "gif" ? outputPathGIF : outputPathMP4,
      async (err) => {
        if (err) {
          console.error("Error sending file:", err);
        }
        await fs.remove(exportDir);
      }
    );
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Export failed" });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
