import { handleQStashWebhook, setAppReadyState } from "../index.js";

const healthPaths = ["/health", "/healthz", "/ready"];

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

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith("OK");
    });

    test.each(["/health", "/healthz"])("HEAD %s should return 200 (Liveness)", async (path) => {
        const req = createHealthRequest(path, "HEAD");
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalled();
    });

    test("GET /ready should return 503 with Not Ready body", async () => {
        const req = createHealthRequest("/ready", "GET");
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(503);
        expect(res.end).toHaveBeenCalledWith("Not Ready");
    });

    test("HEAD /ready should return 503 with empty body", async () => {
        const req = createHealthRequest("/ready", "HEAD");
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(503);
        expect(res.end).toHaveBeenCalled();
    });
});

describe("Health & Readiness Endpoints - after ready", () => {
    beforeEach(() => {
        setAppReadyState(true);
    });

    test.each(healthPaths)("GET %s should return 200 OK", async (path) => {
        const req = createHealthRequest(path, "GET");
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith("OK");
    });

    test.each(healthPaths)("HEAD %s should return 200 with empty body", async (path) => {
        const req = createHealthRequest(path, "HEAD");
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalled();
    });
});
