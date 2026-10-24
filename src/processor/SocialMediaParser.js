import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { sanitizeExternalFileName } from "./ExternalUrlPolicy.js";
import { logger } from "../services/logger/index.js";
const log = logger?.withModule ? logger.withModule("SocialMediaParser") : console;

const execFileAsync = promisify(execFile);

// Platform regex patterns
export const SOCIAL_DOMAINS = [
    // Douyin
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?douyin\.com\/[^\s<>"'`]+/i,
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?iesdouyin\.com\/[^\s<>"'`]+/i,

    // TikTok
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s<>"'`]+/i,

    // Twitter / X
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/(?:#!\/)?(?:\w+)\/status(?:es)?\/\d+[^\s<>"'`]*/i,

    // Instagram
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/[\w-]+[^\s<>"'`]*/i,

    // Threads
    /(?:https?:\/\/)?(?:[a-zA-Z0-9_-]+\.)?threads\.(?:net|com)\/(?:@[\w.-]+\/post|t)\/[\w-]+[^\s<>"'`]*/i
];

const BOT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const GOOGLEBOT_USER_AGENT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/**
 * Checks whether an input URL matches any supported social media platform.
 * @param {string} url 
 * @returns {boolean}
 */
export function isSocialMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    return SOCIAL_DOMAINS.some(pattern => pattern.test(url));
}

/**
 * Extracts all valid social media URLs from a text string.
 * @param {string} text 
 * @returns {string[]}
 */
export function extractSocialMediaUrls(text) {
    if (!text || typeof text !== "string") return [];
    const matchedItems = [];
    for (const pattern of SOCIAL_DOMAINS) {
        const regex = new RegExp(pattern.source, "gi");
        let match;
        while ((match = regex.exec(text)) !== null) {
            let cleaned = match[0].replace(/[),.;\]}]+$/g, "").trim();
            if (!/^https?:\/\//i.test(cleaned)) {
                cleaned = `https://${cleaned}`;
            }
            try {
                const parsed = new URL(cleaned);
                matchedItems.push({ index: match.index, url: parsed.toString() });
            } catch {
                // Ignore malformed URL
            }
        }
    }
    matchedItems.sort((a, b) => a.index - b.index);
    return [...new Set(matchedItems.map(item => item.url))];
}

/**
 * Main parser entry point. Detects platform, queries highest-clarity media, and falls back to yt-dlp.
 * @param {string} url 
 * @param {object} options
 * @returns {Promise<{ platform: string, title: string, author: string, originalUrl: string, media: Array<{ type: string, url: string, quality: string, fileName: string, fileSize?: number, headers?: Record<string, string>, useYtDlp?: boolean, webUrl?: string }> } | null>}
 */
export async function parseSocialMedia(url, options = {}) {
    if (!url) return null;

    try {
        // 1. Twitter / X
        if (/(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com/i.test(url)) {
            const result = await parseTwitter(url, options);
            if (result && result.media?.length > 0) return result;
        }

        // 2. Douyin / TikTok
        if (/(?:douyin\.com|tiktok\.com)/i.test(url)) {
            const result = await parseTikTokOrDouyin(url, options);
            if (result && result.media?.length > 0) return result;
        }

        // 3. Threads
        if (/threads\.(?:net|com)/i.test(url)) {
            const result = await parseThreads(url, options);
            if (result && result.media?.length > 0) return result;
        }

        // 4. Instagram
        if (/(?:instagram\.com|instagr\.am)/i.test(url)) {
            const result = await parseInstagram(url, options);
            if (result && result.media?.length > 0) return result;
        }

        // 5. Universal yt-dlp fallback
        const ytdlpResult = await parseViaYtDlp(url, options);
        if (ytdlpResult && ytdlpResult.media?.length > 0) return ytdlpResult;

    } catch (err) {
        log?.warn?.("SocialMediaParser: extraction failed", { url, error: err.message });
    }

    return null;
}

// -------------------------------------------------------------
// Twitter / X Extractor
// -------------------------------------------------------------
export async function parseTwitter(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const tweetIdMatch = url.match(/(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/(?:#!\/)?(?:\w+)\/status(?:es)?\/(\d+)/i);
    if (!tweetIdMatch) return null;
    const tweetId = tweetIdMatch[1];

    // Primary: FxTwitter API
    try {
        const res = await fetchImpl(`https://api.fxtwitter.com/i/status/${tweetId}`, {
            headers: { "User-Agent": "DriveCollectorBot/4.0", "Accept": "application/json" }
        });
        if (res.ok) {
            const data = await res.json();
            const tweet = data?.tweet;
            if (tweet) {
                const author = tweet.author?.name || tweet.author?.screen_name || "Twitter";
                const title = tweet.text ? tweet.text.replace(/\s+/g, " ").trim() : `Tweet ${tweetId}`;
                const mediaItems = [];

                // Videos: sort variants descending by bitrate to select the highest definition
                if (Array.isArray(tweet.media?.videos) && tweet.media.videos.length > 0) {
                    for (let i = 0; i < tweet.media.videos.length; i++) {
                        const vid = tweet.media.videos[i];
                        const variants = (vid.variants || [])
                            .filter(v => v.content_type === "video/mp4" && v.url)
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                        const best = variants[0] || { url: vid.url };
                        if (best.url) {
                            const quality = best.bitrate ? `${Math.round(best.bitrate / 1000)}k` : "highest";
                            const suffix = tweet.media.videos.length > 1 ? `_${i + 1}` : "";
                            mediaItems.push({
                                type: "video",
                                url: best.url,
                                quality,
                                bitrate: best.bitrate || 0,
                                fileName: sanitizeFileName(`[X] ${author} - ${title.slice(0, 40)}_${tweetId}${suffix}.mp4`),
                                platform: "X"
                            });
                        }
                    }
                }

                // Photos: append ?name=orig for original highest resolution
                if (Array.isArray(tweet.media?.photos) && tweet.media.photos.length > 0) {
                    for (let i = 0; i < tweet.media.photos.length; i++) {
                        const photo = tweet.media.photos[i];
                        let photoUrl = photo.url;
                        if (photoUrl && photoUrl.includes("twimg.com")) {
                            photoUrl = photoUrl.includes("?")
                                ? photoUrl.replace(/name=[^&]+/, "name=orig")
                                : `${photoUrl}?name=orig`;
                        }
                        const suffix = tweet.media.photos.length > 1 ? `_${i + 1}` : "";
                        mediaItems.push({
                            type: "photo",
                            url: photoUrl,
                            quality: "original",
                            fileName: sanitizeFileName(`[X] ${author} - ${tweetId}${suffix}.jpg`),
                            platform: "X"
                        });
                    }
                }

                if (mediaItems.length > 0) {
                    return {
                        platform: "X",
                        title,
                        author,
                        originalUrl: url,
                        media: mediaItems
                    };
                }
            }
        }
    } catch {}

    // Fallback: Twitter syndication API
    try {
        const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=1`;
        const res = await fetchImpl(syndicationUrl, {
            headers: { "User-Agent": BOT_USER_AGENT }
        });
        if (res.ok) {
            const tweet = await res.json();
            const author = tweet.user?.name || tweet.user?.screen_name || "Twitter";
            const title = tweet.text ? tweet.text.replace(/\s+/g, " ").trim() : `Tweet ${tweetId}`;
            const mediaItems = [];

            if (tweet.video?.variants?.length > 0) {
                const mp4Variants = tweet.video.variants
                    .filter(v => (v.type === "video/mp4" || v.content_type === "video/mp4") && (v.src || v.url))
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                const best = mp4Variants[0];
                if (best) {
                    const videoUrl = best.src || best.url;
                    mediaItems.push({
                        type: "video",
                        url: videoUrl,
                        quality: best.bitrate ? `${Math.round(best.bitrate / 1000)}k` : "highest",
                        fileName: sanitizeFileName(`[X] ${author} - ${tweetId}.mp4`),
                        platform: "X"
                    });
                }
            } else if (Array.isArray(tweet.photos) && tweet.photos.length > 0) {
                for (let i = 0; i < tweet.photos.length; i++) {
                    const p = tweet.photos[i];
                    let photoUrl = p.url;
                    if (photoUrl && photoUrl.includes("twimg.com")) {
                        photoUrl = photoUrl.includes("?")
                            ? photoUrl.replace(/name=[^&]+/, "name=orig")
                            : `${photoUrl}?name=orig`;
                    }
                    mediaItems.push({
                        type: "photo",
                        url: photoUrl,
                        quality: "original",
                        fileName: sanitizeFileName(`[X] ${author} - ${tweetId}_${i + 1}.jpg`),
                        platform: "X"
                    });
                }
            }

            if (mediaItems.length > 0) {
                return { platform: "X", title, author, originalUrl: url, media: mediaItems };
            }
        }
    } catch {}

    return null;
}

// -------------------------------------------------------------
// Douyin & TikTok Extractor
// -------------------------------------------------------------
export async function parseTikTokOrDouyin(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    let targetUrl = url;

    // Follow short share redirects (e.g. v.douyin.com / vt.tiktok.com)
    if (/v\.douyin\.com|vt\.tiktok\.com|vm\.tiktok\.com/i.test(targetUrl)) {
        try {
            const headRes = await fetchImpl(targetUrl, {
                method: "HEAD",
                redirect: "manual",
                headers: { "User-Agent": BOT_USER_AGENT }
            });
            const location = headRes.headers.get("location");
            if (location) {
                targetUrl = location.startsWith("http") ? location : new URL(location, targetUrl).toString();
            }
        } catch {}
    }

    const isDouyin = /douyin\.com/i.test(targetUrl);
    const platform = isDouyin ? "Douyin" : "TikTok";

    // Call TikWM API with hd=1 for 1080p / highest clarity
    try {
        const bodyParams = new URLSearchParams();
        bodyParams.append("url", targetUrl);
        bodyParams.append("hd", "1");

        const res = await fetchImpl("https://www.tikwm.com/api/", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "DriveCollectorBot/4.0"
            },
            body: bodyParams.toString()
        });

        if (res.ok) {
            const json = await res.json();
            if (json.code === 0 && json.data) {
                const data = json.data;
                const author = data.author?.nickname || data.author?.unique_id || platform;
                const title = data.title ? data.title.replace(/\s+/g, " ").trim() : `${platform} ${data.id || "video"}`;
                const mediaItems = [];

                // Photo album
                if (Array.isArray(data.images) && data.images.length > 0) {
                    for (let i = 0; i < data.images.length; i++) {
                        mediaItems.push({
                            type: "photo",
                            url: data.images[i],
                            quality: "original",
                            fileName: sanitizeFileName(`[${platform}] ${author} - ${(data.id || "photo")}_${i + 1}.jpg`),
                            platform
                        });
                    }
                } else {
                    // Video: default to highest definition (hdplay, fallback to play)
                    const videoUrl = data.hdplay || data.play;
                    if (videoUrl) {
                        const directUrl = videoUrl.startsWith("http") ? videoUrl : `https://www.tikwm.com${videoUrl}`;
                        mediaItems.push({
                            type: "video",
                            url: directUrl,
                            quality: data.hdplay ? "1080p HD" : "highest",
                            fileName: sanitizeFileName(`[${platform}] ${author} - ${title.slice(0, 50)}.mp4`),
                            fileSize: data.hd_size || data.size || 0,
                            platform
                        });
                    }
                }

                if (mediaItems.length > 0) {
                    return { platform, title, author, originalUrl: url, media: mediaItems };
                }
            }
        }
    } catch {}

    return null;
}

// -------------------------------------------------------------
// Threads Extractor
// -------------------------------------------------------------
export async function parseThreads(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const codeMatch = url.match(/threads\.(?:net|com)\/(?:@[\w.-]+\/post|t)\/([\w-]+)/i);
    const shortcode = codeMatch ? codeMatch[1] : null;

    try {
        const res = await fetchImpl(url, {
            headers: {
                "User-Agent": GOOGLEBOT_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        });

        if (res.ok) {
            const html = await res.text();
            const posts = [];
            const scriptMatches = html.matchAll(/<script type="application\/json"[^>]*>(.*?)<\/script>/gs);
            for (const match of scriptMatches) {
                try {
                    const parsed = JSON.parse(match[1]);
                    findThreadsMediaPosts(parsed, posts);
                } catch {}
            }

            const targetPost = (shortcode ? posts.find(p => p.code === shortcode) : null) || posts[0];
            if (targetPost) {
                const author = targetPost.user?.username || "Threads";
                const title = targetPost.caption?.text ? targetPost.caption.text.replace(/\s+/g, " ").trim() : `Threads ${shortcode || "post"}`;
                const mediaItems = [];

                if (Array.isArray(targetPost.carousel_media) && targetPost.carousel_media.length > 0) {
                    for (let i = 0; i < targetPost.carousel_media.length; i++) {
                        const item = targetPost.carousel_media[i];
                        addThreadsMediaItem(item, author, shortcode || "item", i + 1, mediaItems);
                    }
                } else {
                    addThreadsMediaItem(targetPost, author, shortcode || "post", null, mediaItems);
                }

                if (mediaItems.length > 0) {
                    return { platform: "Threads", title, author, originalUrl: url, media: mediaItems };
                }
            }
        }
    } catch {}

    return null;
}

function findThreadsMediaPosts(node, results) {
    if (!node || typeof node !== "object") return;
    if (node.video_versions || node.image_versions2 || node.carousel_media) {
        results.push(node);
        return;
    }
    for (const key of Object.keys(node)) {
        findThreadsMediaPosts(node[key], results);
    }
}

function addThreadsMediaItem(item, author, idPrefix, index, results) {
    const suffix = index ? `_${index}` : "";
    if (Array.isArray(item.video_versions) && item.video_versions.length > 0) {
        // Highest resolution: sort by width * height descending
        const best = [...item.video_versions].sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
        if (best?.url) {
            results.push({
                type: "video",
                url: best.url,
                quality: best.height ? `${best.height}p` : "highest",
                fileName: sanitizeFileName(`[Threads] ${author} - ${idPrefix}${suffix}.mp4`),
                platform: "Threads"
            });
            return;
        }
    }

    if (item.image_versions2?.candidates?.length > 0) {
        // Highest resolution image candidate
        const bestImg = [...item.image_versions2.candidates].sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
        if (bestImg?.url) {
            results.push({
                type: "photo",
                url: bestImg.url,
                quality: "original",
                fileName: sanitizeFileName(`[Threads] ${author} - ${idPrefix}${suffix}.jpg`),
                platform: "Threads"
            });
        }
    }
}

// -------------------------------------------------------------
// Instagram Extractor
// -------------------------------------------------------------
export async function parseInstagram(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
    const shortcode = match ? match[1] : null;
    if (!shortcode) return null;

    // Check embed captioned page
    try {
        const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
        const res = await fetchImpl(embedUrl, {
            headers: { "User-Agent": BOT_USER_AGENT }
        });
        if (res.ok) {
            const html = await res.text();
            const videoUrlMatch = html.match(/"video_url":"([^"]+)"/);
            if (videoUrlMatch) {
                const videoUrl = JSON.parse(`"${videoUrlMatch[1]}"`);
                return {
                    platform: "Instagram",
                    title: `Instagram ${shortcode}`,
                    author: "Instagram",
                    originalUrl: url,
                    media: [{
                        type: "video",
                        url: videoUrl,
                        quality: "highest",
                        fileName: sanitizeFileName(`[Instagram] ${shortcode}.mp4`),
                        platform: "Instagram"
                    }]
                };
            }
        }
    } catch {}

    return null;
}

// -------------------------------------------------------------
// Universal yt-dlp Extractor & Downloader
// -------------------------------------------------------------
export async function parseViaYtDlp(url, options = {}) {
    try {
        const { stdout } = await execFileAsync("yt-dlp", [
            "-J",
            "--no-warnings",
            "--no-playlist",
            "-f", "bestvideo*+bestaudio/best",
            url
        ], {
            timeout: 25000
        });

        const info = JSON.parse(stdout);
        const title = info.title ? info.title.replace(/\s+/g, " ").trim() : "media";
        const author = info.uploader || info.channel || info.extractor || "Media";
        const platform = info.extractor_key || info.extractor || "Media";

        // Check if format has direct progressive download URL with both audio & video
        const formats = Array.isArray(info.formats) ? info.formats : [];
        const directCombined = formats
            .filter(f => f.url && f.vcodec !== "none" && f.acodec !== "none" && /^https?:\/\//i.test(f.url))
            .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)) || ((b.tbr || 0) - (a.tbr || 0)));

        const bestDirect = directCombined[0];
        const isDashOrSeparate = !bestDirect || (info.requested_formats && info.requested_formats.length > 1);

        if (isDashOrSeparate) {
            // Requires yt-dlp to download and mux video + audio
            const height = info.height || (info.requested_formats?.[0]?.height) || 0;
            const quality = height ? `${height}p` : "highest";
            return {
                platform,
                title,
                author,
                originalUrl: url,
                media: [{
                    type: "video",
                    url,
                    quality,
                    fileName: sanitizeFileName(`[${platform}] ${author} - ${title.slice(0, 50)}.mp4`),
                    fileSize: info.filesize || info.filesize_approx || 0,
                    useYtDlp: true,
                    webUrl: url,
                    platform
                }]
            };
        }

        // Direct HTTP URL available
        const height = bestDirect.height || 0;
        const quality = height ? `${height}p` : "highest";
        return {
            platform,
            title,
            author,
            originalUrl: url,
            media: [{
                type: "video",
                url: bestDirect.url,
                quality,
                fileName: sanitizeFileName(`[${platform}] ${author} - ${title.slice(0, 50)}.${bestDirect.ext || "mp4"}`),
                fileSize: bestDirect.filesize || bestDirect.filesize_approx || 0,
                headers: bestDirect.http_headers || null,
                platform
            }]
        };
    } catch {}

    return null;
}

/**
 * Executes a download via yt-dlp with real-time heartbeat and progress tracking.
 * @param {string} webUrl 
 * @param {string} localPath 
 * @param {object} options 
 */
export async function downloadViaYtDlp(webUrl, localPath, options = {}) {
    const { heartbeat, task, log } = options;
    const partialPath = `${localPath}.part`;
    const outputTemplate = `${partialPath}.%(ext)s`;

    await fs.promises.rm(partialPath, { force: true }).catch(() => {});

    return new Promise((resolve, reject) => {
        let childProcess;
        let isSettled = false;
        let downloadedBytes = 0;
        let totalBytes = task?.fileInfo?.size || 0;

        const cleanup = async () => {
            if (childProcess && !childProcess.killed) {
                try { childProcess.kill("SIGTERM"); } catch {}
            }
        };

        childProcess = spawn("yt-dlp", [
            "--newline",
            "--progress",
            "--no-warnings",
            "--no-playlist",
            "-f", "bestvideo*+bestaudio/best",
            "--merge-output-format", "mp4",
            "-o", outputTemplate,
            webUrl
        ]);

        childProcess.stdout.on("data", (data) => {
            const text = data.toString();
            // Parse: [download]  45.2% of ~  15.00MiB at  2.50MiB/s
            const percentMatch = text.match(/\[download\]\s+([\d.]+)%/);
            if (percentMatch && heartbeat) {
                const percent = parseFloat(percentMatch[1]);
                if (totalBytes > 0) {
                    downloadedBytes = Math.round((percent / 100) * totalBytes);
                }
                heartbeat("downloading", downloadedBytes, totalBytes).catch(() => {});
            }
        });

        childProcess.stderr.on("data", (data) => {
            const text = data.toString();
            log?.debug?.("yt-dlp stderr", { text });
        });

        childProcess.on("error", async (err) => {
            if (isSettled) return;
            isSettled = true;
            await cleanup();
            reject(err);
        });

        childProcess.on("close", async (code) => {
            if (isSettled) return;
            isSettled = true;
            if (code !== 0) {
                return reject(new Error(`yt-dlp exited with error code ${code}`));
            }

            try {
                // Find created file matching partialPath.*
                const dir = path.dirname(partialPath);
                const baseName = path.basename(partialPath);
                const files = await fs.promises.readdir(dir);
                const matched = files.find(f => f.startsWith(baseName));

                if (!matched) {
                    return reject(new Error("yt-dlp output file not found"));
                }

                const actualFilePath = path.join(dir, matched);
                await fs.promises.rename(actualFilePath, localPath);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

function sanitizeFileName(name) {
    return sanitizeExternalFileName(name, "media.mp4");
}
