const { app } = require('../src/index');

describe('Health and API Routes', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    // Start on ephemeral port for tests
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  it('GET /health should return 200 and healthy status payload', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      service: 'ai-job-automation-agent',
      status: 'healthy'
    });
  });

  it('GET /undefined-route should return 404', async () => {
    const response = await fetch(`${baseUrl}/undefined-route`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(404);
  });
});
