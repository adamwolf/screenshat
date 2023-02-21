#!/usr/bin/env node

import {chromium, firefox, webkit} from "playwright";
import path from "path";
import fs from "fs";
import os from "os";
import sizeOf from "image-size";
import {FFMpegProgress} from "ffmpeg-progress-wrapper";
import {InvalidArgumentError, Option, program} from "commander";
import process from 'node:process';

import cliProgress from "cli-progress";
import colors from "ansi-colors";

import {createConsole} from 'verbosity';


function intify(value) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}


function validateHeight(value) {
  if (value === 'full') {
    return value;
  }
  try {
    return intify(value);
  } catch {
    throw new InvalidArgumentError('Not a number or the word "full".');
  }
}

function increaseVerbosity(dummyValue, previous) {
  return previous + 1;
}

function getFfmpegArgs(inputImages, minWidth, maxWidth, videoWidth, videoHeight, videoFiles) {
  let cmdargs = ['-start_number', minWidth, "-i", inputImages]

  // https://ffmpeg.org/ffmpeg-filters.html#pad-1
  // https://ffmpeg.org/ffmpeg-utils.html#color-syntax
  const baseFilter = `pad=w=${videoWidth}:h=${videoHeight}:x=0:y=0:eval=frame:color=black@0x00`;

  const numOutputs = Object.keys(videoFiles).length;
  if (numOutputs > 1) {
    let splitFilter = `split=${numOutputs}`; // https://trac.ffmpeg.org/wiki/Creating%20multiple%20outputs
    for (let i = 0; i < numOutputs; i++) {
      splitFilter += `[out${i + 1}]`;
    }
    cmdargs = cmdargs.concat(['-filter_complex', `${baseFilter},${splitFilter}`]);
  } else if (numOutputs === 1) {
    cmdargs = cmdargs.concat(['-vf', baseFilter]);
  } else if (numOutputs === 0) {
    return;
  }

  // videoFiles is a dictionary with type as the key
  // videoTypes is a sorted list of the keys
  const videoTypes = Object.keys(videoFiles).sort();

  for (let i = 0; i < videoTypes.length; i++) {
    const videoType = videoTypes[i];
    const output_fpath = videoFiles[videoType];

    if (numOutputs > 1) {
      cmdargs = cmdargs.concat(['-map', `[out${i + 1}]`]);
    }

    if (videoType === 'mp4') {
      cmdargs = cmdargs.concat([
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', // Change pixel format so video can be played on more players; https://superuser.com/a/666994
        '-movflags', '+faststart', // improve streamability
        output_fpath]);
    } else if (videoType === 'png') {
      cmdargs = cmdargs.concat([
        '-c:v', 'apng',
        '-pix_fmt', 'rgba',
        output_fpath]);
    } else if (videoType === 'gif') {
      cmdargs = cmdargs.concat([
        '-c:v', 'gif',
        '-pix_fmt', 'rgb24',
        output_fpath]);
    } else if (videoType === 'webm') {
      cmdargs = cmdargs.concat([
        '-c:v', 'libvpx-vp9',
        '-b:v', '800k',
        '-pix_fmt', 'yuva420p',
        output_fpath]);
    }
  }
  return cmdargs;
}


/*
  * Print a message to the console.
  * It's a little silly, but it means to show intent when using `verbosity` to wrangle logging with the console object.
  * We should probably look at this and do it better.
 */
function consoleprint(msg) {
  const loglevel = console.verbosity;
  console.verbosity = 3;
  console.log(msg);
  console.verbosity = loglevel;
}


(async () => {
  program
    .name('screenshat')
    .usage('[options] --url <url>')
    .description('Take screenshots and videos of a website at different widths\n\n' +
      'Requires ffmpeg to be installed and in your PATH.')
    .requiredOption('--url <url>', 'URL to screenshot')
    .option('--min-width <pixels>', 'minimum width', intify, 320)
    .option('--max-width <pixels>', 'maximum width', intify, 1920)
    .option('--max-height <pixels>', 'maximum height in pixels, or "full"', validateHeight, 800)
    .addOption(new Option('--output-dir <dir>', 'output directory').default(null, 'new temp directory'))
    .option('--browser <browser>', 'browser to use with Playwright, like chromium, firefox, or webkit', 'chromium')
    .option('--no-progress', 'disable progress bars')
    .option('--json', 'print details as JSON (it can be helpful to include --quiet)')
    .option('--output-mp4', 'output mp4 video')
    .option('--output-webm', 'output webm video')
    .option('--output-gif', 'output animated gif')
    .option('--output-png', 'output animated png')
    .option('-q, --quiet', 'produce minimal command-line output')
    .option('-v, --verbose', 'produce more command-line output', increaseVerbosity, 0)
    .showHelpAfterError();
  program.parse();

  const options = program.opts();

  let loglevel = 1; //default to error and other things of that level

  if (options.quiet) {
    loglevel = 1; //errors only
  } else if (options.verbose === 1) {
    loglevel = 3; //log+warn+errors
  } else if (options.verbose === 2) {
    loglevel = 4; //info+log+warn+errors+
  } else if (options.verbose >= 3) {
    loglevel = 5; //debug+info+log+warn+errors
  }

  const console = createConsole({
    outStream: process.stdout,
    errorStream: process.stderr,
    verbosity: loglevel,
    global: true,
    colors: true,
  });

  if (options.quiet && options.verbose > 0) {
    console.error("Can't be both quiet and verbose");
    process.exit(1);
  }

  if (options.minWidth > options.maxWidth) {
    console.error(`Minimum width (${options.minWidth}) can't be greater than maximum width (${options.maxWidth})`);
    process.exit(1);
  }

  const show_progress_bars = !options.quiet && options.progress;

  let outputDir = options.outputDir;

  // if no output dir was set, make a tempdir
  if (!outputDir) {
    console.debug('Creating temp directory');
    await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `screenshat-${options.browser}-${options.minWidth}px-to${options.maxWidth}px`)
    ).then(
      (directory) => {outputDir = directory}
    );
  }

  let maxHeight;
  if (options.maxHeight === 'full') {
    maxHeight = null;
  } else {
    maxHeight = options.maxHeight;
  }

  const generateVideo = options.outputMp4 || options.outputWebm || options.outputGif || options.outputPng;

  let videoFiles = {};
  let videoBase = `video-${options.browser}-${options.minWidth}px-to-${options.maxWidth}px`
  if (options.outputMp4) {
    videoFiles.mp4 = path.join(outputDir,  `${videoBase}.mp4`);
  }
  if (options.outputWebm) {
    videoFiles.webm = path.join(outputDir, `${videoBase}.webm`);
  }
  if (options.outputGif) {
    videoFiles.gif = path.join(outputDir, `${videoBase}.gif`);
  }
  if (options.outputPng) {
    videoFiles.png = path.join(outputDir, `${videoBase}.png`);
  }

  const minWidth = options.minWidth;
  const maxWidth = options.maxWidth;

  console.info("Launching browser")

  let browser;
  if (options.browser === 'chromium') {
    browser = await chromium.launch();
  } else if (options.browser === 'firefox') {
    browser = await firefox.launch();
  } else if (options.browser === 'webkit') {
    browser = await webkit.launch();
  } else {
    console.error(`Unrecognized browser: ${options.browser}`);
    process.exit(1);
  }

  console.log(`Taking screenshots of ${options.url} into directory ${outputDir} from ${minWidth} to ${maxWidth} pixels wide`);

  const page = await browser.newPage();
  console.debug("Navigating to " + options.url)
  await page.goto(options.url);

  const numWidthDigits = maxWidth.toString().length;
  let tallestScreenshotHeight = 0;
  let widestScreenshotWidth = 0;

  let screenshotProgress;
  if (show_progress_bars) {
    screenshotProgress = new cliProgress.SingleBar({
      format: 'Taking screenshots |' + colors.cyan('{bar}') + '| {percentage}% || {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    screenshotProgress.start(maxWidth - minWidth + 1, 0);
  }

  // The captured full page screenshots include full *width*.
  // We may want full *length*, but if the width is wider than the window, we want to cut it off.
  // We are able to tell Playwright a clip region.  We can't say "any length", so we set an arbitrary height
  // and if our screenshot is that height, we print a small warning, increase the arbitrary height, and try again.
  let fpath;
  let heightLimit;
  if (maxHeight == null) {
    heightLimit = 10000;
  } else {
    heightLimit = maxHeight;
  }

  for (let width = minWidth; width <= maxWidth; width++) {
    console.debug(`Taking screenshot of ${options.url} at ${width} pixels wide`)
    // Note: this height doesn't matter too much,
    // since we're taking full length screenshots
    await page.setViewportSize({width: width, height: 800});

    const formattedWidth = width.toString().padStart(numWidthDigits, '0');
    fpath = path.join(outputDir, `screenshot-${options.browser}-${formattedWidth}.png`);

    await page.screenshot({path: fpath, fullPage: true, clip: {x: 0, y: 0, width: width, height: heightLimit}});
    let dimensions = await sizeOf(fpath);
    while (maxHeight == null && dimensions.height >= heightLimit) {
      console.warn(`Height limit (${heightLimit} reached, increasing.`);
      heightLimit = dimensions.height + 1000;
      await page.screenshot({path: fpath, fullPage: true, clip: {x: 0, y: 0, width: width, height: heightLimit}});
      dimensions = await sizeOf(fpath);
    }

    if (dimensions.height > tallestScreenshotHeight) {
      tallestScreenshotHeight = dimensions.height;
    }

    if (dimensions.width > widestScreenshotWidth) {
      widestScreenshotWidth = dimensions.width;
    }

    console.debug(`Screenshot saved to ${fpath} (${dimensions.width}x${dimensions.height})`)
    if (show_progress_bars) {
      screenshotProgress.increment();
    }
  }

  if (show_progress_bars) {
    screenshotProgress.stop();
  }

  console.info(`The longest image was ${tallestScreenshotHeight} pixels tall.`);
  console.info(`The widest image was ${widestScreenshotWidth} pixels wide.`);

  console.debug("Closing browser")
  await browser.close();

  let jsonDetails = {
      browser: options.browser,
      outputDir: outputDir,
      minWidth: minWidth,
      maxWidth: maxWidth,
      maxHeight: maxHeight,
      tallestScreenshotHeight: tallestScreenshotHeight,
      widestScreenshotWidth: widestScreenshotWidth,
      numDigits: numWidthDigits,
      url: options.url
    }

  if (!generateVideo) {
    if (options.json) {
      consoleprint(JSON.stringify(jsonDetails));
    }
    if (!options.outputDir && !options.quiet) { // This means we created it and aren't in quiet mode
      consoleprint(`Output screenshots are in ${outputDir}`);
    }
    process.exit(0);
  }

  const printableVideoTypes = Object.keys(videoFiles).join(', ');
  console.log(`Generating video (${printableVideoTypes})`);

  // Make sure the heights and widths are even, since it's needed for some video formats

  let videoHeight = tallestScreenshotHeight;
  if (videoHeight % 2 !== 0) {
    videoHeight += 1;
  }

  let videoWidth = widestScreenshotWidth;
  if (videoWidth % 2 !== 0) {
    videoWidth += 1;
  }

  const inputImages = `${outputDir}/screenshot-${options.browser}-%${numWidthDigits}d.png`
  let cmdargs = getFfmpegArgs(inputImages, minWidth, maxWidth, videoWidth, videoHeight, videoFiles);
  if (cmdargs === null) {
    console.error("Could not generate ffmpeg arguments");
    process.exit(1);
  }

  // print each argument, but surround them with ' and escape any ' in the argument
  const printableArgs = cmdargs.map(arg => `'${arg.toString().replace(/'/g, "'\\''")}'`).join(' ');
  console.debug(`Running ffmpeg with arguments: ${printableArgs}`);

  jsonDetails.videoFiles = videoFiles;
  jsonDetails.videoHeight = videoHeight;
  jsonDetails.videoWidth = videoWidth;
  jsonDetails.ffmpegArgs = cmdargs;

  if (options.json) {
    consoleprint(JSON.stringify(jsonDetails));
  }

  let videoProgress;
  if (show_progress_bars) {
    const videoProgressLabel = `Generating video (${printableVideoTypes})`;
    videoProgress = new cliProgress.SingleBar({
      format: `${videoProgressLabel} |` + colors.cyan('{bar}') + '| {percentage}%',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    videoProgress.start(1, 0);
  }

  const ffmpegProcess = new FFMpegProgress(cmdargs)

  ffmpegProcess.on('raw', console.debug);

  ffmpegProcess.once('details', (details) => console.debug(JSON.stringify(details)));

  ffmpegProcess.on('progress', (progress) => {
    console.debug(JSON.stringify(progress))
    if (show_progress_bars) {
      videoProgress.update(progress.progress); // progress is a number between 0 and 1
    }
  });

  ffmpegProcess.once('end', function (code) {
    if (show_progress_bars) {
      if (code === 0) {
        videoProgress.update(1);
      }
      videoProgress.stop();
    }

    if (code === 0) {
      console.log(`Video creation finished successfully.`);
      if (!options.outputDir && !options.quiet) { // This means we created it and aren't in quiet mode
        consoleprint(`Output files are in ${outputDir}`);
      }
    } else {
      console.error(`Video creation failed and exited with code ${code}`);
      process.exit(1);
    }
  });

  await ffmpegProcess.onDone();
})();
