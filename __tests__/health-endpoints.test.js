import { handleWebhook, setAppReadyState } from "../index.js";

const healthPaths = ["/health", "/healthz", "/ready"];
const originalEnv = {
    APP_VERSION: process.env.APP_VERSION,
    GIT_SHA: process.env.GIT_SHA,
    BUILD_TIME: process.env.BUILD_TIME,
    IMAGE_TAG: process.env.IMAGE_TAG
};

const createHealthRequest = (path, method = "GET") => ({
    url: path,
    method,
    headers: {
        host: "localhost"
    }
});

const createMockResponse = () => ({
    writeHead: vi.fn(),
    end: vi.fn()
});

describe("Health & Readiness Endpoints - before ready", () => {
    beforeEach(() => {
        setAppReadyState(false);
    });

    test.each(["/health", "/healthz"])("GET %s should return 200 OK (Liveness)", async (path) => {
        const req = createHealthRequest(path, "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith("OK");
    });

    test.each(["/health", "/healthz"])("HEAD %s should return 200 (Liveness)", async (path) => {
        const req = createHealthRequest(path, "HEAD");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalled();
    });

    test("GET /ready should return 503 with Not Ready body", async () => {
        const req = createHealthRequest("/ready", "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(503);
        expect(res.end).toHaveBeenCalledWith("Not Ready");
    });

    test("HEAD /ready should return 503 with empty body", async () => {
        const req = createHealthRequest("/ready", "HEAD");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(503);
        expect(res.end).toHaveBeenCalled();
    });
});

describe("Health & Readiness Endpoints - after ready", () => {
    beforeEach(() => {
        setAppReadyState(true);
        global.appInitializer = { businessModulesRunning: true };
    });

    afterEach(() => {
        delete global.appInitializer;
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    test.each(healthPaths)("GET %s should return 200 OK", async (path) => {
        const req = createHealthRequest(path, "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith("OK");
    });

    test.each(healthPaths)("HEAD %s should return 200 with empty body", async (path) => {
        const req = createHealthRequest(path, "HEAD");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalled();
    });

    test.each(["/health", "/healthz"])("GET %s should remain 200 when business modules are down", async (path) => {
        global.appInitializer = { businessModulesRunning: false };
        const req = createHealthRequest(path, "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith("OK");
    });

    test("GET /ready should return 503 when business modules are down", async () => {
        global.appInitializer = { businessModulesRunning: false };
        const req = createHealthRequest("/ready", "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(503);
        expect(res.end).toHaveBeenCalledWith("Service Unavailable: Business Modules Down");
    });

    test("GET /version should expose build identity without requiring readiness", async () => {
        process.env.APP_VERSION = "4.33.1";
        process.env.GIT_SHA = "abcdef1234567890";
        process.env.BUILD_TIME = "2026-05-18T00:00:00.000Z";
        process.env.IMAGE_TAG = "repo/app:sha-abcdef1";
        setAppReadyState(false);

        const req = createHealthRequest("/version", "GET");
        const res = createMockResponse();

        await handleWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
        expect(JSON.parse(res.end.mock.calls[0][0])).toEqual(expect.objectContaining({
            version: "4.33.1",
            gitSha: "abcdef1234567890",
            shortGitSha: "abcdef123456",
            buildTime: "2026-05-18T00:00:00.000Z",
            imageTag: "repo/app:sha-abcdef1",
            releaseId: "4.33.1+abcdef123456"
        }));
    });
});
