const axios = require('axios');
const {
  fetchGreenhouseJobs,
  fetchAllGreenhouseJobs,
  normalizeGreenhouseJob,
  cleanHtmlToText
} = require('../src/scrapers/greenhouse');
const jobRepository = require('../src/services/jobRepository');
const config = require('../src/config/env');

jest.mock('axios');

describe('Greenhouse Scraper', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('HTML Content Sanitization (cleanHtmlToText)', () => {
    it('should strip scripts, styles, and tags while preserving text and structure', () => {
      const rawHtml = `
        <style>.heading { color: red; }</style>
        <script>console.log('secret');</script>
        <h2>About the Role</h2>
        <p>We are seeking a <strong>Principal Engineer</strong> to lead our platform team.</p>
        <br/>
        <ul>
          <li>Design resilient microservices</li>
          <li>Scale MongoDB clusters</li>
        </ul>
      `;

      const text = cleanHtmlToText(rawHtml);
      expect(text).not.toContain('console.log');
      expect(text).not.toContain('color: red');
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<li>');
      expect(text).toContain('About the Role');
      expect(text).toContain('We are seeking a Principal Engineer');
      expect(text).toContain('Design resilient microservices');
      expect(text).toContain('Scale MongoDB clusters');
    });

    it('should unescape and parse entity-encoded HTML strings', () => {
      const encodedHtml = '&lt;p&gt;Built with &lt;strong&gt;Node.js&lt;/strong&gt;&lt;/p&gt;';
      const text = cleanHtmlToText(encodedHtml);
      expect(text).toBe('Built with Node.js');
    });

    it('should handle null, undefined, or non-string inputs safely', () => {
      expect(cleanHtmlToText(null)).toBe('');
      expect(cleanHtmlToText(undefined)).toBe('');
      expect(cleanHtmlToText(123)).toBe('');
    });
  });

  describe('Job Normalization (normalizeGreenhouseJob)', () => {
    it('should normalize valid Greenhouse raw job into internal schema format', () => {
      const rawJob = {
        id: 7654321,
        title: ' Senior Full Stack Developer ',
        absolute_url: ' https://boards.greenhouse.io/stripe/jobs/7654321 ',
        location: { name: ' San Francisco, CA ' },
        content: '<p>Exciting opportunity at Stripe!</p>'
      };

      const normalized = normalizeGreenhouseJob(rawJob, 'stripe');

      expect(normalized).toEqual({
        title: 'Senior Full Stack Developer',
        company: 'stripe',
        atsSource: 'greenhouse',
        jobUrl: 'https://boards.greenhouse.io/stripe/jobs/7654321',
        description: 'Exciting opportunity at Stripe!',
        location: 'San Francisco, CA',
        fitScore: null,
        verdict: null,
        matchingSkills: [],
        missingSkills: [],
        status: 'pending',
        notified: false
      });
    });

    it('should return null if title or absolute_url is missing', () => {
      expect(normalizeGreenhouseJob({ title: 'Engineer' }, 'test')).toBeNull();
      expect(normalizeGreenhouseJob({ absolute_url: 'https://url.com' }, 'test')).toBeNull();
      expect(normalizeGreenhouseJob(null, 'test')).toBeNull();
    });

    it('should handle missing location object gracefully', () => {
      const rawJob = {
        title: 'Engineer',
        absolute_url: 'https://boards.greenhouse.io/test/jobs/1',
        location: null
      };

      const normalized = normalizeGreenhouseJob(rawJob, 'test');
      expect(normalized.location).toBe('');
    });
  });

  describe('fetchGreenhouseJobs', () => {
    it('should reject invalid or missing company slug', async () => {
      await expect(fetchGreenhouseJobs('')).rejects.toThrow('Valid company slug is required');
      await expect(fetchGreenhouseJobs(null)).rejects.toThrow('Valid company slug is required');
    });

    it('should fetch, normalize, and bulk-insert jobs successfully', async () => {
      const mockApiResponse = {
        data: {
          jobs: [
            {
              id: 101,
              title: 'Backend Engineer',
              absolute_url: 'https://boards.greenhouse.io/airbnb/jobs/101',
              location: { name: 'Remote' },
              content: '<p>Build high-scale APIs</p>'
            },
            {
              id: 102,
              title: 'Frontend Engineer',
              absolute_url: 'https://boards.greenhouse.io/airbnb/jobs/102',
              location: { name: 'San Francisco' },
              content: '<p>Build UI with React</p>'
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

      const result = await fetchGreenhouseJobs('airbnb');

      expect(axios.get).toHaveBeenCalledWith(
        'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true',
        expect.any(Object)
      );
      expect(bulkInsertSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        company: 'airbnb',
        totalFetched: 2,
        newInserted: 2,
        duplicatesSkipped: 0,
        success: true
      });

      bulkInsertSpy.mockRestore();
    });

    it('should handle malformed API responses without throwing', async () => {
      axios.get.mockResolvedValueOnce({ data: { jobs: null } });

      const result = await fetchGreenhouseJobs('bad-company');

      expect(result).toEqual({
        company: 'bad-company',
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: true
      });
    });

    it('should handle 404 HTTP errors gracefully without retrying', async () => {
      const notFoundError = new Error('Request failed with status code 404');
      notFoundError.response = { status: 404 };

      axios.get.mockRejectedValue(notFoundError);

      const result = await fetchGreenhouseJobs('nonexistent-company');

      // Should only try once for 404
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.company).toBe('nonexistent-company');
    });
  });

  describe('fetchAllGreenhouseJobs', () => {
    it('should process configured companies sequentially and aggregate results', async () => {
      const originalCompanies = config.companies.greenhouse;
      config.companies.greenhouse = ['company-a', 'company-b'];

      // Mock company A success, company B 404
      axios.get
        .mockResolvedValueOnce({
          data: {
            jobs: [
              {
                id: 201,
                title: 'Staff Engineer',
                absolute_url: 'https://boards.greenhouse.io/company-a/jobs/201',
                content: 'Staff role'
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

      const summary = await fetchAllGreenhouseJobs();

      expect(summary.totalCompanies).toBe(2);
      expect(summary.successfulCompanies).toBe(1);
      expect(summary.failedCompanies).toBe(1);
      expect(summary.totalJobsFetched).toBe(1);
      expect(summary.totalJobsInserted).toBe(1);

      bulkInsertSpy.mockRestore();
      config.companies.greenhouse = originalCompanies;
    });

    it('should return empty summary when no companies are configured', async () => {
      const originalCompanies = config.companies.greenhouse;
      config.companies.greenhouse = [];

      const summary = await fetchAllGreenhouseJobs();

      expect(summary.totalCompanies).toBe(0);
      expect(summary.results).toEqual([]);

      config.companies.greenhouse = originalCompanies;
    });
  });
});
