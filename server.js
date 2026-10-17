import express from "express";
import {
  Innertube,
  UniversalCache,
  Platform,
} from "youtubei.js";

import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import {
  buildURL,
  parseLooseJSON,
  getHeaders,
  USER_AGENT,
} from "bgutils-js/utils";

import { JSDOM } from "jsdom";

const app = express();

/*
 * Render/Railway/Fly inject PORT at runtime; fall back to 3001 for local dev.
 */
const PORT = process.env.PORT || 3001;

/*
 * Allow the Vercel-hosted Next.js app (and anything else) to call this
 * service directly if needed. The Next.js route proxies server-to-server,
 * so this isn't strictly required for that path, but it's needed if you
 * ever hit /health or /stream directly from a browser for debugging.
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/*
 * EXACT evaluator used by the working RetroPod project.
 */
Platform.shim.eval = async (data) => {
  return new Function(data.output)();
};

let youtube = null;

let webPoMinter = null;
let webPoInitPromise = null;
let webPoDom = null;


/* ---------------------------------------------------------
   YOUTUBE
--------------------------------------------------------- */

async function getYouTube() {
  if (!youtube) {
    youtube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      retrieve_player: true,
    });
  }

  return youtube;
}


/* ---------------------------------------------------------
   WEB PO TOKEN
--------------------------------------------------------- */

async function initializeWebPoMinter() {
  console.log("[YouTube PO] Initializing BotGuard/WebPO...");

  const dom = new JSDOM(
    "<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>",
    {
      url: "https://www.youtube.com",
      referrer: "https://www.youtube.com/",
      userAgent: USER_AGENT,
    }
  );

  webPoDom = dom;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: dom.window.location,
  });

  Object.defineProperty(globalThis, "origin", {
    configurable: true,
    value: dom.window.origin,
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });

  try {
    const pageResponse = await fetch("https://www.youtube.com", {
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.7",
        "user-agent": USER_AGENT,
      },
    });

    if (!pageResponse.ok) {
      throw new Error(
        `YouTube homepage returned HTTP ${pageResponse.status}.`
      );
    }

    const pageHtml = await pageResponse.text();

    const ytConfigMatch = pageHtml.match(
      /ytcfg\.set\(({.+?})\);/s
    );

    if (!ytConfigMatch) {
      throw new Error("Could not find YouTube ytcfg.");
    }

    const ytConfig = JSON.parse(ytConfigMatch[1]);

    dom.window.yt = {
      config_: ytConfig,
    };

    globalThis.yt = dom.window.yt;

    const initialAttestationData = pageHtml.match(
      /window\.ytAtN\(\s*({[\s\S]*?})\s*\)/
    );

    if (!initialAttestationData) {
      throw new Error(
        "Could not find YouTube BotGuard challenge."
      );
    }

    const initialAttestationDataJson = parseLooseJSON(
      initialAttestationData[1]
    );

    const challengeResponse =
      initialAttestationDataJson.R;

    if (!challengeResponse?.bgChallenge) {
      throw new Error(
        "YouTube did not provide a BotGuard challenge."
      );
    }

    const interpreterUrl =
      challengeResponse.bgChallenge.interpreterUrl
        ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

    if (!interpreterUrl) {
      throw new Error(
        "YouTube did not provide a BotGuard interpreter URL."
      );
    }

    console.log(
      "[YouTube PO] Loading BotGuard interpreter..."
    );

    const bgScriptResponse = await fetch(
      `https:${interpreterUrl}`,
      {
        headers: {
          "user-agent": USER_AGENT,
        },
      }
    );

    if (!bgScriptResponse.ok) {
      throw new Error(
        `BotGuard interpreter returned HTTP ${bgScriptResponse.status}.`
      );
    }

    const interpreterJavascript =
      await bgScriptResponse.text();

    if (!interpreterJavascript) {
      throw new Error(
        "YouTube returned an empty BotGuard interpreter."
      );
    }

    new Function(interpreterJavascript)();

    console.log(
      "[YouTube PO] Creating BotGuard client..."
    );

    const botGuardClient = await BotGuardClient.create({
      program: challengeResponse.bgChallenge.program,
      globalName:
        challengeResponse.bgChallenge.globalName,
      globalObject: globalThis,
    });

    const webPoSignalOutput = [];

    console.log(
      "[YouTube PO] Creating BotGuard snapshot..."
    );

    const botguardResponse =
      await botGuardClient.snapshot({
        webPoSignalOutput,
      });

    const requestKey = "O43z0dpjhgX20SCx4KAo";

    const integrityTokenResponse = await fetch(
      buildURL("GenerateIT", true),
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify([
          requestKey,
          botguardResponse,
        ]),
      }
    );

    if (!integrityTokenResponse.ok) {
      throw new Error(
        `GenerateIT returned HTTP ${integrityTokenResponse.status}.`
      );
    }

    const integrityTokenJson =
      await integrityTokenResponse.json();

    const [
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    ] = integrityTokenJson;

    if (!integrityToken) {
      throw new Error(
        "YouTube did not return an integrity token."
      );
    }

    console.log(
      "[YouTube PO] Creating WebPO minter..."
    );

    const minter = await WebPoMinter.create(
      {
        integrityToken,
        estimatedTtlSecs,
        mintRefreshThreshold,
        websafeFallbackToken,
      },
      webPoSignalOutput
    );

    console.log("[YouTube PO] WebPO ready.");

    return minter;

  } catch (error) {
    if (webPoDom === dom) {
      webPoDom = null;

      try {
        dom.window.close();
      } catch {}
    }

    throw error;
  }
}


async function getWebPoMinter() {
  if (webPoMinter) {
    return webPoMinter;
  }

  if (!webPoInitPromise) {
    webPoInitPromise =
      initializeWebPoMinter();
  }

  try {
    webPoMinter =
      await webPoInitPromise;

    return webPoMinter;

  } catch (error) {
    webPoInitPromise = null;
    webPoMinter = null;

    throw error;
  }
}


async function getWebPoToken(videoId) {
  const minter =
    await getWebPoMinter();

  console.log(
    `[YouTube PO] Minting content token for ${videoId}`
  );

  if (!webPoDom) {
    throw new Error(
      "WebPO browser environment is not available."
    );
  }

  const token =
    await minter.mintAsWebsafeString(videoId);

  if (!token) {
    throw new Error(
      `Failed to mint WebPO token for ${videoId}.`
    );
  }

  console.log(
    `[YouTube PO] Token generated for ${videoId}`
  );

  return token;
}


/* ---------------------------------------------------------
   HEALTH
--------------------------------------------------------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "RetroPod Stream Server",
  });
});


/* ---------------------------------------------------------
   STREAM
--------------------------------------------------------- */

app.get("/stream", async (req, res) => {
  const videoId = req.query.id?.trim();

  if (!videoId) {
    return res.status(400).json({
      error: "Video ID is required.",
    });
  }

  try {
    console.log(
      `[YouTube Audio] Resolving audio-only stream for ${videoId}`
    );

    const yt = await getYouTube();

    console.log(
      `[YouTube Audio] Trying MWEB client for ${videoId}`
    );

    const format =
      await yt.getStreamingData(
        videoId,
        {
          client: "MWEB",
          type: "audio",
          quality: "best",
        }
      );

    const url = format.url;

    if (!url) {
      throw new Error(
        "YouTube returned no playable MWEB audio URL."
      );
    }

    console.log(
      `[YouTube Audio] MWEB selected itag=${format.itag}, mime=${format.mime_type}`
    );

    const poToken =
      await getWebPoToken(videoId);

    const separator =
      url.includes("?") ? "&" : "?";

    const playableUrl =
      `${url}${separator}pot=${encodeURIComponent(poToken)}`;

    console.log(
      `[YouTube Audio] WebPO token attached to ${videoId}`
    );

    const headers = {
      Accept: "*/*",
      "User-Agent": USER_AGENT,
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(
      playableUrl,
      {
        method: "GET",
        headers,
        redirect: "follow",
      }
    );

    console.log(
      `[YouTube Stream] CDN response: ${upstream.status}`
    );

    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(
        `YouTube audio CDN returned HTTP ${upstream.status}.`
      );
    }

    res.status(upstream.status);

    res.setHeader(
      "Content-Type",
      format.mime_type || "audio/mp4"
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.setHeader(
      "Accept-Ranges",
      "bytes"
    );

    for (const name of [
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const value =
        upstream.headers.get(name);

      if (value) {
        res.setHeader(name, value);
      }
    }

    if (!upstream.body) {
      throw new Error(
        "YouTube returned an empty response body."
      );
    }

    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }

    res.end();

  } catch (error) {
    console.error(
      "[YouTube Stream] ERROR:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    } else {
      res.end();
    }
  }
});


/* ---------------------------------------------------------
   START
--------------------------------------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `RetroPod Stream Server running on port ${PORT}`
  );
});