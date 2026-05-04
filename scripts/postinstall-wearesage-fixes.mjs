import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

function patchFile(filePath, steps) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }

  let content = readFileSync(filePath, "utf8");
  let changed = false;

  for (const step of steps) {
    if (content.includes(step.marker)) {
      continue;
    }

    if (!content.includes(step.search)) {
      throw new Error(`Patch anchor not found in ${filePath}`);
    }

    content = content.replace(step.search, step.replace);
    changed = true;
  }

  if (changed) {
    writeFileSync(filePath, content, "utf8");
  }
}

const root = resolve(process.cwd());
const spotifyStore = resolve(root, "node_modules/@wearesage/vue/src/stores/spotify.ts");
const echoNest = resolve(root, "node_modules/@wearesage/vue/src/composables/audio/useEchoNest.ts");

patchFile(spotifyStore, [
  {
    marker: "Keep polling while linked: play/pause/seek only update when we refetch",
    search: `  function startInterval() {
    stopInterval();
    fetchInterval.value = setInterval(async () => {
      await getCurrentAnalysis();
      if (analysisData.value) stopInterval();
    }, 5000);
  }`,
    replace: `  function startInterval() {
    stopInterval();
    // Keep polling while linked: play/pause/seek only update when we refetch (interval used to stop after first success).
    fetchInterval.value = setInterval(() => {
      void getCurrentAnalysis();
    }, 2500);
  }`,
  },
  {
    marker: "void getCurrentAnalysis().then(() => {\n        startInterval();",
    search: `    if (accessToken.value) {
      getCurrentAnalysis();
      if (!analysisData.value) startInterval();
    }`,
    replace: `    if (accessToken.value) {
      void getCurrentAnalysis().then(() => {
        startInterval();
      });
    }`,
  },
]);

patchFile(echoNest, [
  {
    marker: "When Spotify is paused, freeze motion",
    search: `  watchEffect(() => {
    let tick = 0.01;

    if (playing.value) {
      const fps = raf.frameRate as number;
      const vol = Math.pow(volume.value, 0.75);
      const pSegment = activeIntervals.value?.segments?.[2] as number;
      const pBeat = activeIntervals.value?.beats?.[2] as number;

      if (pSegment && pBeat) {
        const iBeat = interpolateBasis([base(fps), base(fps) * vol + bump(fps) * vol, base(fps)]);
        const iSegment = interpolateBasis([base(fps), base(fps) * vol + bump(fps) * vol, base(fps)]);
        const value = iBeat(pBeat) + iSegment(pSegment);
        if (!isNaN(value)) {
          tick = value;
        }
      }
    }

    stream.value += tick;
  });`,
    replace: `  watchEffect(() => {
    // When Spotify is paused, freeze motion (otherwise tick defaults and the viz never stops)
    if (!playing.value) {
      return;
    }

    let tick = 0.01;

    const fps = raf.frameRate as number;
    const vol = Math.pow(volume.value, 0.75);
    const pSegment = activeIntervals.value?.segments?.[2] as number;
    const pBeat = activeIntervals.value?.beats?.[2] as number;

    if (pSegment && pBeat) {
      const iBeat = interpolateBasis([base(fps), base(fps) * vol + bump(fps) * vol, base(fps)]);
      const iSegment = interpolateBasis([base(fps), base(fps) * vol + bump(fps) * vol, base(fps)]);
      const value = iBeat(pBeat) + iSegment(pSegment);
      if (!isNaN(value)) {
        tick = value;
      }
    }

    stream.value += tick;
  });`,
  },
]);

console.log("Applied wearesage postinstall patches.");
