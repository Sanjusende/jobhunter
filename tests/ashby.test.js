const axios = require('axios');
const {
  fetchAshbyJobs,
  fetchAllAshbyJobs,
  normalizeAshbyJob,
  resolveAshbyLocation,
  extractAshbyDescription,
  cleanHtml
} = require('../src/scrapers/ashby');
const jobRepository = require('../src/services/jobRepository');
const config = require('../src/config/env');

jest.mock('axios');

describe('Ashby Scraper', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Location Resolution (resolveAshbyLocation)', () => {
    it('should format primary location with remote status', () => {
      const location = resolveAshbyLocation('San Francisco, CA', [], true);
      expect(location).toBe('San Francisco, CA (Remote)');
    });

    it('should handle location objects and secondary locations array', () => {
      const location = resolveAshbyLocation(
        { name: 'New York, NY' },
        [{ location: 'London, UK' }, { name: 'Berlin, DE' }],
        false
      );
      expect(location).toBe('New York, NY, London, UK, Berlin, DE');
    });

    it('should not duplicate (Remote) if already present in location text', () => {
      const location = resolveAshbyLocation('Remote - United States', [], true);
      expect(location).toBe('Remote - United States');
    });

    it('should return Remote if only isRemote is true', () => {
      const location = resolveAshbyLocation('', [], true);
      expect(location).toBe('Remote');
    });

    it('should return empty string if no locations provided', () => {
      expect(resolveAshbyLocation(null, [], false)).toBe('');
    });
  });

  describe('Description Extraction (extractAshbyDescription)', () => {
    it('should sanitize HTML descriptions and preserve text structure', () => {
      const rawJob = {
        descriptionHtml: `
          <h3>About Linear</h3>
          <p>We build purpose-built software for modern software development.</p>
          <ul><li>TypeScript & React</li><li>Distributed systems</li></ul>
        `
      };

      const result = extractAshbyDescription(rawJob);
      expect(result).toContain('About Linear');
      expect(result).toContain('We build purpose-built software');
      expect(result).toContain('TypeScript & React');
      expect(result).not.toContain('<h3>');
      expect(result).not.toContain('<ul>');
    });

    it('should fall back to descriptionPlain if HTML is absent', () => {
      const rawJob = {
        descriptionPlain: 'Plain text description for the Ashby role'
      };

      const result = extractAshbyDescription(rawJob);
      expect(result).toBe('Plain text description for the Ashby role');
    });
  });

  describe('Job Normalization (normalizeAshbyJob)', () => {
    it('should normalize a valid Ashby job into the internal Job format', () => {
      const rawJob = {
        id: 'ashby-job-456',
        title: ' Senior Full Stack Engineer ',
        jobUrl: 'https://jobs.ashbyhq.com/linear/ashby-job-456',
        location: 'San Francisco, CA',
        isRemote: true,
        descriptionHtml: '<p>Build lightning-fast web applications.</p>'
      };

      const normalized = normalizeAshbyJob(rawJob, 'linear');

      expect(normalized).toEqual({
        title: 'Senior Full Stack Engineer',
        company: 'linear',
        atsSource: 'ashby',
        jobUrl: 'https://jobs.ashbyhq.com/linear/ashby-job-456',
        description: 'Build lightning-fast web applications.',
        location: 'San Francisco, CA (Remote)',
        fitScore: null,
        verdict: null,
        matchingSkills: [],
        missingSkills: [],
        status: 'pending',
        notified: false
      });
    });

    it('should construct fallback jobUrl from company slug and id if jobUrl is missing', () => {
      const rawJob = {
        id: '789',
        title: 'Staff Designer'
      };

      const normalized = normalizeAshbyJob(rawJob, 'notion');
      expect(normalized.jobUrl).toBe('https://jobs.ashbyhq.com/notion/789');
    });

    it('should return null if title or jobUrl cannot be resolved', () => {
      expect(normalizeAshbyJob({ jobUrl: 'https://url.com' }, 'notion')).toBeNull();
      expect(normalizeAshbyJob({ title: 'Engineer' }, 'notion')).toBeNull();
      expect(normalizeAshbyJob(null, 'notion')).toBeNull();
    });
  });

  describe('fetchAshbyJobs', () => {
    it('should throw validation error for missing company slug', async () => {
      await expect(fetchAshbyJobs('')).rejects.toThrow('Valid company slug is required');
      await expect(fetchAshbyJobs(null)).rejects.toThrow('Valid company slug is required');
    });

    it('should fetch, normalize, and bulk-insert Ashby jobs into database', async () => {
      const mockApiResponse = {
        data: {
          jobs: [
            {
              id: 'job-1',
              title: 'Product Engineer',
              jobUrl: 'https://jobs.ashbyhq.com/linear/job-1',
              location: 'Remote',
              descriptionHtml: '<p>Product team</p>'
            },
            {
              id: 'job-2',
              title: 'Systems Engineer',
              jobUrl: 'https://jobs.ashbyhq.com/linear/job-2',
              location: 'San Francisco',
              descriptionHtml: '<p>Infrastructure team</p>'
            }
          ]
        }
      };

      axios.get.mockResolvedValueOnce(mockApiResponse);
      const bulkInsertSpy = jest.spyOn(jobRepository, 'bulkInsertJobs').mockResolvedValueOnce({
        total: 2,
        inserted: 2,
        duplicates: 0
      });

      const result = await fetchAshbyJobs('linear');

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.ashbyhq.com/posting-api/job-board/linear',
        expect.any(Object)
      );
      expect(bulkInsertSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        company: 'linear',
        totalFetched: 2,
        newInserted: 2,
        duplicatesSkipped: 0,
        success: true
      });

      bulkInsertSpy.mockRestore();
    });

    it('should handle duplicate jobs correctly by reporting skipped count', async () => {
      const mockApiResponse = {
        data: {
          jobs: [
            {
              id: 'job-dup-1',
              title: 'DevOps Engineer',
              jobUrl: 'https://jobs.ashbyhq.com/notion/job-dup-1',
              location: 'Remote'
            }
          ]
        }
      };

      axios.get.mockResolvedValueOnce(mockApiResponse);
      const bulkInsertSpy = jest.spyOn(jobRepository, 'bulkInsertJobs').mockResolvedValueOnce({
        total: 1,
        inserted: 0,
        duplicates: 1
      });

      const result = await fetchAshbyJobs('notion');

      expect(result).toEqual({
        company: 'notion',
        totalFetched: 1,
        newInserted: 0,
        duplicatesSkipped: 1,
        success: true
      });

      bulkInsertSpy.mockRestore();
    });

    it('should handle malformed API responses without throwing error', async () => {
      axios.get.mockResolvedValueOnce({ data: { jobs: null } });

      const result = await fetchAshbyJobs('malformed-corp');

      expect(result).toEqual({
        company: 'malformed-corp',
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: true
      });
    });

    it('should handle 404 client errors without infinite retries', async () => {
      const notFoundError = new Error('Request failed with status code 404');
      notFoundError.response = { status: 404 };

      axios.get.mockRejectedValue(notFoundError);

      const result = await fetchAshbyJobs('nonexistent-company');

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.company).toBe('nonexistent-company');
    });
  });

  describe('fetchAllAshbyJobs', () => {
    it('should process configured companies sequentially and return aggregated summary', async () => {
      const originalCompanies = config.companies.ashby;
      config.companies.ashby = ['ashby-co-1', 'ashby-co-2'];

      axios.get
        .mockResolvedValueOnce({
          data: {
            jobs: [
              {
                id: 'ashby-1',
                title: 'Backend Engineer',
                jobUrl: 'https://jobs.ashbyhq.com/ashby-co-1/ashby-1'
              }
            ]
          }
        })
        .mockRejectedValueOnce({
          response: { status: 404 },
          message: 'Not found'
        });

      const bulkInsertSpy = jest.spyOn(jobRepository, 'bulkInsertJobs').mockResolvedValueOnce({
        total: 1,
        inserted: 1,
        duplicates: 0
      });

      const summary = await fetchAllAshbyJobs();

      expect(summary).toEqual({
        companiesProcessed: 2,
        jobsFetched: 1,
        jobsInserted: 1,
        duplicates: 0,
        failures: 1,
        results: expect.any(Array)
      });

      bulkInsertSpy.mockRestore();
      config.companies.ashby = originalCompanies;
    });

    it('should return zeroed summary if ASHBY_COMPANIES is empty', async () => {
      const originalCompanies = config.companies.ashby;
      config.companies.ashby = [];

      const summary = await fetchAllAshbyJobs();

      expect(summary).toEqual({
        companiesProcessed: 0,
        jobsFetched: 0,
        jobsInserted: 0,
        duplicates: 0,
        failures: 0,
        results: []
      });

      config.companies.ashby = originalCompanies;
    });
  });
});
