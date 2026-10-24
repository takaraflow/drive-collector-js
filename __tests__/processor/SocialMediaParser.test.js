import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    isSocialMediaUrl,
    extractSocialMediaUrls,
    parseTwitter,
    parseTikTokOrDouyin,
    parseThreads,
    parseInstagram,
    parseSocialMedia
} from "../../src/processor/SocialMediaParser.js";

describe("SocialMediaParser", () => {
    describe("URL Matching & Extraction", () => {
        it("identifies supported social media platforms", () => {
            expect(isSocialMediaUrl("https://x.com/jack/status/20")).toBe(true);
            expect(isSocialMediaUrl("https://twitter.com/jack/status/20")).toBe(true);
            expect(isSocialMediaUrl("https://v.douyin.com/iRN1234/")).toBe(true);
            expect(isSocialMediaUrl("https://www.douyin.com/video/71234567890")).toBe(true);
            expect(isSocialMediaUrl("https://vt.tiktok.com/ZS8ABCDE/")).toBe(true);
            expect(isSocialMediaUrl("https://www.tiktok.com/@user/video/71234567890")).toBe(true);
            expect(isSocialMediaUrl("https://www.threads.net/@zuck/post/Cx1234567")).toBe(true);
            expect(isSocialMediaUrl("https://www.instagram.com/reel/C123456/")).toBe(true);
            expect(isSocialMediaUrl("https://example.com/file.mp4")).toBe(false);
            expect(isSocialMediaUrl("https://google.com")).toBe(false);
        });

        it("extracts multiple social media links from text", () => {
            const text = "Check this out https://x.com/user/status/123456 and also https://v.douyin.com/abcd123/";
            const urls = extractSocialMediaUrls(text);
            expect(urls).toHaveLength(2);
            expect(urls[0]).toContain("x.com/user/status/123456");
            expect(urls[1]).toContain("v.douyin.com/abcd123");
        });

        it("strips trailing punctuation from links in text", () => {
            const text = "See: (https://x.com/user/status/987654), and https://www.threads.net/@user/post/abcd.";
            const urls = extractSocialMediaUrls(text);
            expect(urls).toEqual([
                "https://x.com/user/status/987654",
                "https://www.threads.net/@user/post/abcd"
            ]);
        });
    });

    describe("Twitter / X Extractor (Highest Resolution Preference)", () => {
        it("extracts video variants and selects highest bitrate stream", async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    code: 200,
                    message: "OK",
                    tweet: {
                        id: "123456789",
                        text: "Great 4K video footage!",
                        author: { name: "CoolCreator", screen_name: "cool_creator" },
                        media: {
                            videos: [
                                {
                                    variants: [
                                        { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/720p.mp4" },
                                        { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/1080p.mp4" },
                                        { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/360p.mp4" }
                                    ]
                                }
                            ]
                        }
                    }
                })
            });

            const result = await parseTwitter("https://x.com/cool_creator/status/123456789", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.platform).toBe("X");
            expect(result.author).toBe("CoolCreator");
            expect(result.media).toHaveLength(1);
            // Must pick 1080p (highest bitrate: 2176000)
            expect(result.media[0].url).toBe("https://video.twimg.com/1080p.mp4");
            expect(result.media[0].quality).toBe("2176k");
            expect(result.media[0].fileName).toContain("CoolCreator");
        });

        it("extracts photo carousels with ?name=orig for original quality", async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    code: 200,
                    tweet: {
                        id: "555666",
                        text: "Sunset photos",
                        author: { name: "Photographer" },
                        media: {
                            photos: [
                                { url: "https://pbs.twimg.com/media/photo1.jpg?name=small" },
                                { url: "https://pbs.twimg.com/media/photo2.jpg" }
                            ]
                        }
                    }
                })
            });

            const result = await parseTwitter("https://x.com/photographer/status/555666", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.media).toHaveLength(2);
            expect(result.media[0].url).toBe("https://pbs.twimg.com/media/photo1.jpg?name=orig");
            expect(result.media[1].url).toBe("https://pbs.twimg.com/media/photo2.jpg?name=orig");
            expect(result.media[0].quality).toBe("original");
        });
    });

    describe("Douyin / TikTok Extractor (Highest Resolution Preference)", () => {
        it("extracts watermark-free HD 1080p video from Douyin", async () => {
            const mockFetch = vi.fn().mockImplementation((url) => {
                if (url.includes("tikwm.com")) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => ({
                            code: 0,
                            data: {
                                id: "7123456789",
                                title: "Beautiful fireworks display",
                                author: { nickname: "FireworkMaster" },
                                play: "/video/watermark_free_sd.mp4",
                                hdplay: "/video/watermark_free_hd1080.mp4",
                                size: 5000000,
                                hd_size: 15000000
                            }
                        })
                    });
                }
                return Promise.resolve({ ok: false });
            });

            const result = await parseTikTokOrDouyin("https://www.douyin.com/video/7123456789", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.platform).toBe("Douyin");
            expect(result.media).toHaveLength(1);
            // Default to highest clarity (hdplay)
            expect(result.media[0].url).toBe("https://www.tikwm.com/video/watermark_free_hd1080.mp4");
            expect(result.media[0].quality).toBe("1080p HD");
            expect(result.media[0].fileSize).toBe(15000000);
        });

        it("extracts full image albums for photo posts", async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    code: 0,
                    data: {
                        id: "998877",
                        title: "Travel photo album",
                        author: { nickname: "Traveler" },
                        images: [
                            "https://p3.douyinpic.com/img1.jpg",
                            "https://p3.douyinpic.com/img2.jpg"
                        ]
                    }
                })
            });

            const result = await parseTikTokOrDouyin("https://www.tiktok.com/@user/video/998877", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.platform).toBe("TikTok");
            expect(result.media).toHaveLength(2);
            expect(result.media[0].type).toBe("photo");
            expect(result.media[0].quality).toBe("original");
        });
    });

    describe("Threads Extractor (Highest Resolution Preference)", () => {
        it("extracts highest resolution video candidate from embedded SSR JSON", async () => {
            const mockHtml = `
            <!DOCTYPE html>
            <html>
            <body>
            <script type="application/json">
            {
                "user": { "username": "meta_dev" },
                "caption": { "text": "Exciting demo clip!" },
                "code": "Cxyz123",
                "video_versions": [
                    { "width": 640, "height": 360, "url": "https://cdn.threads.net/360p.mp4" },
                    { "width": 1920, "height": 1080, "url": "https://cdn.threads.net/1080p.mp4" },
                    { "width": 1280, "height": 720, "url": "https://cdn.threads.net/720p.mp4" }
                ]
            }
            </script>
            </body>
            </html>
            `;

            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                text: async () => mockHtml
            });

            const result = await parseThreads("https://www.threads.net/@meta_dev/post/Cxyz123", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.platform).toBe("Threads");
            expect(result.media).toHaveLength(1);
            // Must pick 1080p (width * height largest)
            expect(result.media[0].url).toBe("https://cdn.threads.net/1080p.mp4");
            expect(result.media[0].quality).toBe("1080p");
        });
    });

    describe("Instagram Extractor", () => {
        it("extracts video URL from captioned embed markup", async () => {
            const mockHtml = `
            <!DOCTYPE html>
            <html>
            <body>
            <script>
            {"shortcode":"Cabc123","video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/vid.mp4?bytestream"}
            </script>
            </body>
            </html>
            `;

            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                text: async () => mockHtml
            });

            const result = await parseInstagram("https://www.instagram.com/reel/Cabc123/", { fetchImpl: mockFetch });
            expect(result).not.toBeNull();
            expect(result.platform).toBe("Instagram");
            expect(result.media[0].url).toBe("https://scontent.cdninstagram.com/v/vid.mp4?bytestream");
        });
    });
});
