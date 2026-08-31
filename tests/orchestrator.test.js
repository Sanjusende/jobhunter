const { runJobHunter, app } = require('../src/index');
const database = require('../src/config/database');
const jobIngestionService = require('../src/services/jobIngestionService');
const aiMatcher = require('../src/services/aiMatcher');
const emailService = require('../src/services/emailService');

jest.mock('../src/config/database');
jest.mock('../src/services/jobIngestionService');
jest.mock('../src/services/aiMatcher');
jest.mock('../src/services/emailService');

describe('Application Orchestrator (runJobHunter)', () => {
  let server;
  let baseUrl;

  const mockScrapingSuccess = {
    greenhouse: { totalJobsFetched: 10, totalJobsInserted: 8, totalDuplicatesSkipped: 2, failedCompanies: 0 },
    lever: { jobsFetched: 5, jobsInserted: 4, duplicates: 1, failures: 0 },
    ashby: { jobsFetched: 6, jobsInserted: 5, duplicates: 1, failures: 0 },
    totalFetched: 21,
    totalInserted: 17,
    totalDuplicates: 4,
    totalFailures: 0
  };

  const mockMatchingSuccess = {
    totalProcessed: 5,
    matched: 3,
    ignored: 2,
    failed: 0,
    results: [
      { jobId: 'job-1', title: 'Senior Backend Engineer', fitScore: 88, status: 'matched', success: true },
      { jobId: 'job-2', title: 'Full Stack Engineer', fitScore: 75, status: 'matched', success: true }
    ]
  };

  const mockEmailSuccess = {
    sent: true,
    jobsSent: 2,
    jobIds: ['job-1', 'job-2']
  };

  beforeAll((done) => {
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

  beforeEach(() => {
    jest.clearAllMocks();
    database.connectDB.mockResolvedValue();
    database.disconnectDB.mockResolvedValue();
  });

  it('1. should execute complete pipeline successfully (connect, scrape, match, email, disconnect)', async () => {
    jobIngestionService.runAllScrapers.mockResolvedValueOnce(mockScrapingSuccess);
    aiMatcher.matchPendingJobs.mockResolvedValueOnce(mockMatchingSuccess);
    emailService.sendJobDigest.mockResolvedValueOnce(mockEmailSuccess);

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(database.connectDB).toHaveBeenCalledTimes(1);
    expect(jobIngestionService.runAllScrapers).toHaveBeenCalledTimes(1);
    expect(aiMatcher.matchPendingJobs).toHaveBeenCalledTimes(1);
    expect(emailService.sendJobDigest).toHaveBeenCalledTimes(1);
    expect(database.disconnectDB).toHaveBeenCalledTimes(1);

    expect(result.success).toBe(true);
    expect(result.scraping).toEqual(mockScrapingSuccess);
    expect(result.matching).toEqual(mockMatchingSuccess);
    expect(result.email).toEqual(mockEmailSuccess);
    expect(typeof result.durationMs).toBe('number');
  });

  it('2. should succeed when no eligible jobs exist for email digest (NO_ELIGIBLE_JOBS)', async () => {
    const mockEmailSkipped = {
      sent: false,
      reason: 'NO_ELIGIBLE_JOBS'
    };

    jobIngestionService.runAllScrapers.mockResolvedValueOnce(mockScrapingSuccess);
    aiMatcher.matchPendingJobs.mockResolvedValueOnce(mockMatchingSuccess);
    emailService.sendJobDigest.mockResolvedValueOnce(mockEmailSkipped);

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(result.success).toBe(true);
    expect(result.email).toEqual(mockEmailSkipped);
    expect(database.disconnectDB).toHaveBeenCalledTimes(1);
  });

  it('3. should handle scraper failure gracefully and still continue to matching and email', async () => {
    jobIngestionService.runAllScrapers.mockRejectedValueOnce(new Error('Network offline during scraping'));
    aiMatcher.matchPendingJobs.mockResolvedValueOnce(mockMatchingSuccess);
    emailService.sendJobDigest.mockResolvedValueOnce(mockEmailSuccess);

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(result.scraping.totalFailures).toBe(1);
    expect(result.scraping.error).toBe('Network offline during scraping');
    expect(aiMatcher.matchPendingJobs).toHaveBeenCalledTimes(1);
    expect(emailService.sendJobDigest).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(database.disconnectDB).toHaveBeenCalledTimes(1);
  });

  it('4. should mark success as false if AI matching encounters a fatal failure', async () => {
    jobIngestionService.runAllScrapers.mockResolvedValueOnce(mockScrapingSuccess);
    aiMatcher.matchPendingJobs.mockRejectedValueOnce(new Error('Gemini API Quota Exceeded 429'));
    emailService.sendJobDigest.mockResolvedValueOnce({ sent: false, reason: 'NO_ELIGIBLE_JOBS' });

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(result.success).toBe(false);
    expect(result.matching.error).toBe('Gemini API Quota Exceeded 429');
    expect(database.disconnectDB).toHaveBeenCalledTimes(1);
  });

  it('5. should mark success as false if email delivery fails with an error', async () => {
    jobIngestionService.runAllScrapers.mockResolvedValueOnce(mockScrapingSuccess);
    aiMatcher.matchPendingJobs.mockResolvedValueOnce(mockMatchingSuccess);
    emailService.sendJobDigest.mockRejectedValueOnce(new Error('SMTP Auth Invalid Login'));

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(result.success).toBe(false);
    expect(result.email.error).toBe('SMTP Auth Invalid Login');
    expect(result.email.sent).toBe(false);
    expect(database.disconnectDB).toHaveBeenCalledTimes(1);
  });

  it('6. should ensure disconnectDB is always called in finally block even on fatal error', async () => {
    jobIngestionService.runAllScrapers.mockImplementationOnce(() => {
      throw new Error('Fatal unexpected error');
    });
    aiMatcher.matchPendingJobs.mockImplementationOnce(() => {
      throw new Error('AI crash');
    });

    const result = await runJobHunter({ disconnectOnComplete: true });

    expect(database.disconnectDB).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it('7. should serve /health endpoint correctly on Express app', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      service: 'ai-job-automation-agent',
      status: 'healthy'
    });
  });
});
