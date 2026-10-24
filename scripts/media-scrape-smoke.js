#!/usr/bin/env node
/**
 * Comprehensive Media Scraping Smoke Test
 * Tests media scraping and highest-resolution selection across:
 * - TikTok & Douyin (TikWM API + 1080p HD)
 * - X / Twitter (FxTwitter API + ?name=orig + Bitrate sorting)
 * - Threads (SSR JSON crawler + Carousel / resolution selection)
 * - Instagram (Embed parser + format fallback)
 * - yt-dlp native binary (probe and format selection)
 * - TaskManager external download stream / header forwarding
 */

import {
    isSocialMediaUrl,
    extractSocialMediaUrls,
    parseSocialMedia,
    parseTwitter,
    parseTikTokOrDouyin,
    parseThreads,
    parseInstagram,
    parseViaYtDlp,
    downloadViaYtDlp
} from "../src/processor/SocialMediaParser.js";
import { buildExternalUrlSourceRef } from "../src/domain/task-source.js";
import { openExternalUrlStream, probeExternalUrl } from "../src/processor/ExternalUrlPolicy.js";

const PASS = "\x1b[32m✔ PASS\x1b[0m";
const FAIL = "\x1b[31m✘ FAIL\x1b[0m";

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ${PASS} ${message}`);
        passedCount++;
    } else {
        console.error(`  ${FAIL} ${message}`);
        failedCount++;
    }
}

async function runTest(name, fn) {
    console.log(`\n\x1b[1m[TEST] ${name}\x1b[0m`);
    try {
        await fn();
    } catch (err) {
        console.error(`  ${FAIL} Unexpected error: ${err.message}`);
        failedCount++;
    }
}

async function main() {
    console.log("=================================================");
    console.log("   COMPREHENSIVE MEDIA SCRAPING SMOKE TEST       ");
    console.log("=================================================");

    // 1. URL Detection & Extraction
    await runTest("URL Detection & Extraction in Raw Text", () => {
        const text = `
            Check out Douyin: https://v.douyin.com/i8ABCD/
            And TikTok: https://www.tiktok.com/@user/video/1234567890?is_from_webapp=1
            X / Twitter: https://x.com/jack/status/20
            Instagram: https://www.instagram.com/reel/C3zYy_xM8aN/
            Threads: https://www.threads.net/@meta/post/C4abcdefg
            Ignore generic: https://example.com/file.zip
        `;
        const urls = extractSocialMediaUrls(text);
        assert(urls.length === 5, `Extracted 5 social URLs (found: ${urls.length})`);
        assert(urls[0] === "https://v.douyin.com/i8ABCD/", "Extracted Douyin URL");
        assert(urls[1].startsWith("https://www.tiktok.com"), "Extracted TikTok URL");
        assert(urls[2] === "https://x.com/jack/status/20", "Extracted X URL");
        assert(urls[3] === "https://www.instagram.com/reel/C3zYy_xM8aN/", "Extracted Instagram URL");
        assert(urls[4] === "https://www.threads.net/@meta/post/C4abcdefg", "Extracted Threads URL");
        assert(!isSocialMediaUrl("https://example.com/file.zip"), "Ignored non-social URL");
    });

    // 2. TikTok / Douyin Live Scrape (Highest Resolution 1080p HD)
    await runTest("TikTok / Douyin Live Media Scrape & Highest Resolution", async () => {
        const sampleUrl = "https://www.tiktok.com/@tiktok/video/7106594312292453675";
        const result = await parseTikTokOrDouyin(sampleUrl);
        assert(result !== null, "Successfully queried TikTok endpoint");
        if (result) {
            assert(result.platform === "TikTok", `Platform is TikTok (got: ${result.platform})`);
            assert(result.media.length > 0, `Media found: ${result.media.length} items`);
            const video = result.media[0];
            assert(video.type === "video", "Item type is video");
            assert(video.url.startsWith("http"), `Valid video download URL: ${video.url.slice(0, 50)}...`);
            assert(video.quality === "1080p HD" || video.quality === "highest", `Highest quality flag: ${video.quality}`);
            assert(video.fileName.endsWith(".mp4"), `Proper mp4 filename: ${video.fileName}`);
        }
    });

    // 3. X (Twitter) Live Scrape & Original Photo Resolution
    await runTest("X / Twitter Live Scrape & Original Resolution (?name=orig)", async () => {
        const tweetUrl = "https://twitter.com/TheEllenShow/status/440322224407314432";
        const result = await parseTwitter(tweetUrl);
        assert(result !== null, "Successfully fetched tweet metadata from FxTwitter");
        if (result) {
            assert(result.platform === "X", "Platform is X");
            assert(result.media.length > 0, `Photos found: ${result.media.length}`);
            const photo = result.media[0];
            assert(photo.type === "photo", "Item is photo");
            assert(photo.url.includes("name=orig"), `Appended ?name=orig for original quality: ${photo.url}`);
            assert(photo.quality === "original", "Quality marked as original");
            assert(photo.fileName.includes("[X] The Ellen Show"), `Filename formatted: ${photo.fileName}`);
        }
    });

    // 4. X (Twitter) Video Bitrate Selection Engine
    await runTest("X / Twitter Video Engine Selects Highest Bitrate Variant", async () => {
        const mockTweet = {
            tweet: {
                id: "99999",
                text: "Video test",
                author: { name: "Tester" },
                media: {
                    videos: [{
                        url: "https://video.twimg.com/default.mp4",
                        variants: [
                            { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/low.mp4" },
                            { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
                            { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/med.mp4" }
                        ]
                    }]
                }
            }
        };

        const mockFetch = async () => ({
            ok: true,
            json: async () => mockTweet
        });

        const result = await parseTwitter("https://x.com/Tester/status/99999", { fetchImpl: mockFetch });
        assert(result !== null, "Parsed video tweet");
        assert(result.media[0].url === "https://video.twimg.com/high.mp4", "Chose 2176k stream over lower bitrates");
        assert(result.media[0].bitrate === 2176000, "Preserved highest bitrate");
        assert(result.media[0].quality === "2176k", "Quality tagged with highest bitrate");
    });

    // 5. Threads Crawler & Resolution Selection (SSR)
    await runTest("Threads Scraper SSR & Highest Resolution Stream Selection", async () => {
        const mockHtml = `
            <!DOCTYPE html><html><body>
            <script type="application/json" data-sjs>
            {
                "data": {
                    "data": {
                        "containing_thread": {
                            "thread_items": [{
                                "post": {
                                    "id": "thread123",
                                    "caption": { "text": "Threads launch demo" },
                                    "user": { "username": "meta_dev" },
                                    "video_versions": [
                                        { "url": "https://threads.net/v_low.mp4", "width": 480, "height": 480 },
                                        { "url": "https://threads.net/v_hd.mp4", "width": 1080, "height": 1080 },
                                        { "url": "https://threads.net/v_med.mp4", "width": 720, "height": 720 }
                                    ]
                                }
                            }]
                        }
                    }
                }
            }
            </script></body></html>
        `;

        const mockFetch = async () => ({
            ok: true,
            text: async () => mockHtml
        });

        const result = await parseThreads("https://www.threads.net/@meta_dev/post/thread123", { fetchImpl: mockFetch });
        assert(result !== null, "Parsed Threads SSR post");
        assert(result.platform === "Threads", "Platform is Threads");
        assert(result.media[0].url === "https://threads.net/v_hd.mp4", "Chose 1080x1080 highest resolution stream");
        assert(result.media[0].quality === "1080p", "Quality recorded as 1080p");
    });

    // 6. Instagram Embed Parser
    await runTest("Instagram Embed Scraper & Quality Extraction", async () => {
        const mockEmbedHtml = `
            <div class="EmbeddedMedia">
                <video class="EmbeddedMediaVideo" src="https://instagram.cdn/reel_1080p.mp4"></video>
            </div>
            <script>
            window.__additionalDataLoaded('/p/C_abc/', {
                "graphql": {
                    "shortcode_media": {
                        "is_video": true,
                        "video_url": "https://instagram.cdn/reel_1080p.mp4",
                        "owner": { "username": "photographer" }
                    }
                }
            });
            </script>
        `;

        const mockFetch = async () => ({
            ok: true,
            text: async () => mockEmbedHtml
        });

        const result = await parseInstagram("https://www.instagram.com/reel/C_abc/", { fetchImpl: mockFetch });
        assert(result !== null, "Parsed Instagram reel");
        if (result) {
            assert(result.platform === "Instagram", "Platform is Instagram");
            assert(result.media[0].url === "https://instagram.cdn/reel_1080p.mp4", "Extracted direct reel stream");
            assert(result.media[0].quality === "highest", "Selected highest quality");
        }
    });

    // 7. yt-dlp Native Binary Probe & Format Selection
    await runTest("yt-dlp Native Binary Probe (-f bestvideo*+bestaudio/best)", async () => {
        const sampleUrl = "https://www.tiktok.com/@tiktok/video/7106594312292453675";
        const result = await parseViaYtDlp(sampleUrl);
        assert(result !== null, "yt-dlp executable successfully probed metadata");
        if (result) {
            assert(result.platform === "TikTok", `yt-dlp extractor identified platform: ${result.platform}`);
            assert(result.media.length > 0, "yt-dlp generated downloadable media items");
            assert(result.media[0].url.startsWith("http"), `Valid direct or stream URL generated: ${result.media[0].url.slice(0, 40)}...`);
            assert(result.media[0].quality !== undefined, `Selected best quality: ${result.media[0].quality}`);
        }
    });

    // 8. Task Source Reference & Header Forwarding Contract
    await runTest("SourceRef & Header Forwarding Contract for Protected CDNs", () => {
        const sourceRef = buildExternalUrlSourceRef({
            url: "https://cdn.example.com/video_high.mp4",
            fileName: "video.mp4",
            fileSize: 10485760,
            headers: {
                "Referer": "https://www.tiktok.com/",
                "User-Agent": "Mozilla/5.0"
            },
            useYtDlp: false,
            webUrl: "https://www.tiktok.com/@user/video/123",
            platform: "TikTok",
            quality: "1080p HD"
        });

        assert(sourceRef.url === "https://cdn.example.com/video_high.mp4", "Target URL preserved");
        assert(sourceRef.headers?.Referer === "https://www.tiktok.com/", "Referer header preserved in sourceRef");
        assert(sourceRef.platform === "TikTok", "Platform preserved");
        assert(sourceRef.quality === "1080p HD", "Quality preserved");
        assert(sourceRef.webUrl === "https://www.tiktok.com/@user/video/123", "WebUrl preserved");
    });

    // Summary
    console.log("\n=================================================");
    console.log(`SMOKE TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
    console.log("=================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Fatal error during smoke test:", err);
    process.exit(1);
});
