const axios = require('axios');
const {
  fetchLeverJobs,
  fetchAllLeverJobs,
  normalizeLeverJob,
  resolveLeverLocation,
  assembleLeverDescription,
  cleanHtml
} = require('../src/scrapers/lever');
const jobRepository = require('../src/services/jobRepository');
const config = require('../src/config/env');

jest.mock('axios');

describe('Lever Scraper', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Location Resolution (resolveLeverLocation)', () => {
    it('should format location with workplace type', () => {
      const location = resolveLeverLocation(
        { location: 'San Francisco, CA' },
        'remote'
      );
      expect(location).toBe('San Francisco, CA (Remote)');
    });

    it('should handle allLocations array when primary location is missing', () => {
      const location = resolveLeverLocation(
        { allLocations: ['New York, NY', 'London, UK'] },
        'hybrid'
      );
      expect(location).toBe('New York, NY, London, UK (Hybrid)');
    });

    it('should not duplicate remote keyword if already present in location', () => {
      const location = resolveLeverLocation(
        { location: 'Remote - United States' },
        'remote'
      );
      expect(location).toBe('Remote - United States');
    });

    it('should handle empty or null categories gracefully', () => {
      expect(resolveLeverLocation(null, '')).toBe('');
      expect(resolveLeverLocation({}, '')).toBe('');
      expect(resolveLeverLocation(null, 'remote')).toBe('(Remote)');
    });
  });

  describe('Description Assembly (assembleLeverDescription)', () => {
    it('should combine main description, structured lists, and additional text', () => {
      const rawJob = {
        description: '<p>Join our innovative AI team as a Senior Engineer.</p>',
        lists: [
          {
            text: 'Responsibilities',
            content: '<ul><li>Build microservices</li><li>Deploy to Kubernetes</li></ul>'
          },
          {
            text: 'Qualifications',
            content: '<ul><li>5+ years Node.js experience</li></ul>'
          }
        ],
        additional: '<p>Comprehensive health coverage and 401(k).</p>'
      };

      const result = assembleLeverDescription(rawJob);
      expect(result).toContain('Join our innovative AI team as a Senior Engineer.');
      expect(result).toContain('### Responsibilities');
      expect(result).toContain('Build microservices');
      expect(result).toContain('### Qualifications');
      expect(result).toContain('5+ years Node.js experience');
      expect(result).toContain('Comprehensive health coverage and 401(k).');
    });

    it('should fall back to plain text fields when HTML is absent', () => {
      const rawJob = {
        descriptionPlain: 'Plain description text',
        additionalPlain: 'Plain additional text'
      };

      const result = assembleLeverDescription(rawJob);
      expect(result).toBe('Plain description text\n\nPlain additional text');
    });
  });

  describe('Job Normalization (normalizeLeverJob)', () => {
    it('should normalize a valid Lever job into the internal Job format', () => {
      const rawJob = {
        id: 'lever-job-123',
        text: ' Lead Backend Architect ',
        hostedUrl: 'https://jobs.lever.co/spotify/lever-job-123',
        categories: {
          location: 'Stockholm, Sweden',
          team: 'Core Platform'
        },
        workplaceType: 'hybrid',
        description: '<p>Architect high throughput event pipelines.</p>'
      };

      const normalized = normalizeLeverJob(rawJob, 'spotify');

      expect(normalized).toEqual({
        title: 'Lead Backend Architect',
        company: 'spotify',
        atsSource: 'lever',
        jobUrl: 'https://jobs.lever.co/spotify/lever-job-123',
        description: 'Architect high throughput event pipelines.',
        location: 'Stockholm, Sweden (Hybrid)',
        fitScore: null,
        verdict: null,
        matchingSkills: [],
        missingSkills: [],
        status: 'pending',
        notified: false
      });
    });

    it('should return null if text (title) or jobUrl is missing', () => {
      expect(normalizeLeverJob({ hostedUrl: 'https://url.com' }, 'spotify')).toBeNull();
      expect(normalizeLeverJob({ text: 'Software Engineer' }, 'spotify')).toBeNull();
      expect(normalizeLeverJob(null, 'spotify')).toBeNull();
    });
  });

  describe('fetchLeverJobs', () => {
    it('should throw error for invalid company slug', async () => {
      await expect(fetchLeverJobs('')).rejects.toThrow('Valid company slug is required');
      await expect(fetchLeverJobs(null)).rejects.toThrow('Valid company slug is required');
    });

    it('should fetch, normalize, and bulk-insert Lever jobs successfully', async () => {
      const mockPostings = [
        {
          id: 'post-1',
          text: 'Senior Software Engineer',
          hostedUrl: 'https://jobs.lever.co/netflix/post-1',
          categories: { location: 'Los Gatos, CA' },
          description: '<p>Streaming infrastructure team.</p>'
        },
        {
          id: 'post-2',
          text: 'Data Platform Engineer',
          hostedUrl: 'https://jobs.lever.co/netflix/post-2',
          categories: { location: 'Remote' },
          description: '<p>Real-time analytics.</p>'
        }
      ];

      axios.get.mockResolvedValueOnce({ data: mockPostings });
      const bulkInsertSpy = jest.spyOn(jobRepository, 'bulkInsertJobs').mockResolvedValueOnce({
        total: 2,
        inserted: 2,
        duplicates: 0
      });

      const result = await fetchLeverJobs('netflix');

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.lever.co/v0/postings/netflix?mode=json',
        expect.any(Object)
      );
      expect(bulkInsertSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        company: 'netflix',
        totalFetched: 2,
        newInserted: 2,
        duplicatesSkipped: 0,
        success: true
      });

      bulkInsertSpy.mockRestore();
    });

    it('should handle non-array responses gracefully', async () => {
      axios.get.mockResolvedValueOnce({ data: { message: 'Company not found' } });

      const result = await fetchLeverJobs('invalid-company');

      expect(result).toEqual({
        company: 'invalid-company',
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: true
      });
    });

    it('should handle 404 client errors without infinite retrying', async () => {
      const notFoundError = new Error('Request failed with status code 404');
      notFoundError.response = { status: 404 };

      axios.get.mockRejectedValue(notFoundError);

      const result = await fetchLeverJobs('nonexistent-org');

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.company).toBe('nonexistent-org');
    });
  });

  describe('fetchAllLeverJobs', () => {
    it('should process configured companies sequentially and return formatted summary', async () => {
      const originalCompanies = config.companies.lever;
      config.companies.lever = ['lever-co-1', 'lever-co-2'];

      axios.get
        .mockResolvedValueOnce({
          data: [
            {
              id: 'job-1',
              text: 'Full Stack Engineer',
              hostedUrl: 'https://jobs.lever.co/lever-co-1/job-1'
            }
          ]
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

      const summary = await fetchAllLeverJobs();

      expect(summary).toEqual({
        companiesProcessed: 2,
        jobsFetched: 1,
        jobsInserted: 1,
        duplicates: 0,
        failures: 1,
        results: expect.any(Array)
      });

      bulkInsertSpy.mockRestore();
      config.companies.lever = originalCompanies;
    });

    it('should return zeroed summary if LEVER_COMPANIES is empty', async () => {
      const originalCompanies = config.companies.lever;
      config.companies.lever = [];

      const summary = await fetchAllLeverJobs();

      expect(summary).toEqual({
        companiesProcessed: 0,
        jobsFetched: 0,
        jobsInserted: 0,
        duplicates: 0,
        failures: 0,
        results: []
      });

      config.companies.lever = originalCompanies;
    });
  });
});
