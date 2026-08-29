const { runAllScrapers } = require('../src/services/jobIngestionService');
const scrapers = require('../src/scrapers');

jest.mock('../src/scrapers');

describe('Job Ingestion Service (Unified ATS Orchestrator)', () => {
  const mockGreenhouseSuccess = {
    totalCompanies: 2,
    successfulCompanies: 2,
    failedCompanies: 0,
    totalJobsFetched: 15,
    totalJobsInserted: 10,
    totalDuplicatesSkipped: 5,
    results: []
  };

  const mockLeverSuccess = {
    companiesProcessed: 2,
    jobsFetched: 20,
    jobsInserted: 18,
    duplicates: 2,
    failures: 0,
    results: []
  };

  const mockAshbySuccess = {
    companiesProcessed: 2,
    jobsFetched: 10,
    jobsInserted: 8,
    duplicates: 2,
    failures: 0,
    results: []
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. should execute all scrapers in order and aggregate results when all succeed', async () => {
    scrapers.fetchAllGreenhouseJobs.mockResolvedValueOnce(mockGreenhouseSuccess);
    scrapers.fetchAllLeverJobs.mockResolvedValueOnce(mockLeverSuccess);
    scrapers.fetchAllAshbyJobs.mockResolvedValueOnce(mockAshbySuccess);

    const summary = await runAllScrapers();

    expect(scrapers.fetchAllGreenhouseJobs).toHaveBeenCalledTimes(1);
    expect(scrapers.fetchAllLeverJobs).toHaveBeenCalledTimes(1);
    expect(scrapers.fetchAllAshbyJobs).toHaveBeenCalledTimes(1);

    expect(summary).toEqual({
      greenhouse: mockGreenhouseSuccess,
      lever: mockLeverSuccess,
      ashby: mockAshbySuccess,
      totalFetched: 45, // 15 + 20 + 10
      totalInserted: 36, // 10 + 18 + 8
      totalDuplicates: 9, // 5 + 2 + 2
      totalFailures: 0
    });
  });

  it('2. should continue and aggregate Lever and Ashby when Greenhouse fails', async () => {
    scrapers.fetchAllGreenhouseJobs.mockRejectedValueOnce(new Error('Greenhouse API Down'));
    scrapers.fetchAllLeverJobs.mockResolvedValueOnce(mockLeverSuccess);
    scrapers.fetchAllAshbyJobs.mockResolvedValueOnce(mockAshbySuccess);

    const summary = await runAllScrapers();

    expect(summary.greenhouse.success).toBe(false);
    expect(summary.greenhouse.error).toBe('Greenhouse API Down');
    expect(summary.lever).toEqual(mockLeverSuccess);
    expect(summary.ashby).toEqual(mockAshbySuccess);

    expect(summary.totalFetched).toBe(30); // 0 + 20 + 10
    expect(summary.totalInserted).toBe(26); // 0 + 18 + 8
    expect(summary.totalDuplicates).toBe(4); // 0 + 2 + 2
    expect(summary.totalFailures).toBe(1); // 1 from greenhouse
  });

  it('3. should continue and aggregate Greenhouse and Ashby when Lever fails', async () => {
    scrapers.fetchAllGreenhouseJobs.mockResolvedValueOnce(mockGreenhouseSuccess);
    scrapers.fetchAllLeverJobs.mockRejectedValueOnce(new Error('Lever Network Timeout'));
    scrapers.fetchAllAshbyJobs.mockResolvedValueOnce(mockAshbySuccess);

    const summary = await runAllScrapers();

    expect(summary.greenhouse).toEqual(mockGreenhouseSuccess);
    expect(summary.lever.success).toBe(false);
    expect(summary.lever.error).toBe('Lever Network Timeout');
    expect(summary.ashby).toEqual(mockAshbySuccess);

    expect(summary.totalFetched).toBe(25); // 15 + 0 + 10
    expect(summary.totalInserted).toBe(18); // 10 + 0 + 8
    expect(summary.totalDuplicates).toBe(7); // 5 + 0 + 2
    expect(summary.totalFailures).toBe(1); // 1 from lever
  });

  it('4. should continue and aggregate Greenhouse and Lever when Ashby fails', async () => {
    scrapers.fetchAllGreenhouseJobs.mockResolvedValueOnce(mockGreenhouseSuccess);
    scrapers.fetchAllLeverJobs.mockResolvedValueOnce(mockLeverSuccess);
    scrapers.fetchAllAshbyJobs.mockRejectedValueOnce(new Error('Ashby 503 Service Unavailable'));

    const summary = await runAllScrapers();

    expect(summary.greenhouse).toEqual(mockGreenhouseSuccess);
    expect(summary.lever).toEqual(mockLeverSuccess);
    expect(summary.ashby.success).toBe(false);
    expect(summary.ashby.error).toBe('Ashby 503 Service Unavailable');

    expect(summary.totalFetched).toBe(35); // 15 + 20 + 0
    expect(summary.totalInserted).toBe(28); // 10 + 18 + 0
    expect(summary.totalDuplicates).toBe(7); // 5 + 2 + 0
    expect(summary.totalFailures).toBe(1); // 1 from ashby
  });

  it('5. should handle total pipeline failure gracefully and return zero totals with 3 failures', async () => {
    scrapers.fetchAllGreenhouseJobs.mockRejectedValueOnce(new Error('Greenhouse Crash'));
    scrapers.fetchAllLeverJobs.mockRejectedValueOnce(new Error('Lever Crash'));
    scrapers.fetchAllAshbyJobs.mockRejectedValueOnce(new Error('Ashby Crash'));

    const summary = await runAllScrapers();

    expect(summary.greenhouse.success).toBe(false);
    expect(summary.lever.success).toBe(false);
    expect(summary.ashby.success).toBe(false);

    expect(summary.totalFetched).toBe(0);
    expect(summary.totalInserted).toBe(0);
    expect(summary.totalDuplicates).toBe(0);
    expect(summary.totalFailures).toBe(3);
  });
});
