const { Job } = require('../src/models/Job');
const jobRepository = require('../src/services/jobRepository');

describe('Job Model & Persistence Tests', () => {
  const validJobData = {
    title: 'Senior Backend Engineer',
    company: 'Stripe',
    atsSource: 'greenhouse',
    jobUrl: 'https://boards.greenhouse.io/stripe/jobs/1234567',
    description: 'We are looking for a Node.js engineer...',
    location: 'Remote, US',
    fitScore: 85,
    verdict: 'Strong Match',
    matchingSkills: ['Node.js', 'MongoDB', 'Express'],
    missingSkills: ['Kubernetes'],
    status: 'pending',
    notified: false
  };

  describe('1. Valid Job Document', () => {
    it('should validate a complete, valid job document without errors', async () => {
      const job = new Job(validJobData);
      const validationError = job.validateSync();
      expect(validationError).toBeUndefined();
      expect(job.title).toBe('Senior Backend Engineer');
      expect(job.company).toBe('Stripe');
      expect(job.atsSource).toBe('greenhouse');
      expect(job.fitScore).toBe(85);
      expect(job.verdict).toBe('Strong Match');
      expect(job.status).toBe('pending');
      expect(job.notified).toBe(false);
    });

    it('should apply proper defaults for optional fields', () => {
      const minimalJob = new Job({
        title: 'Software Engineer',
        company: 'Linear',
        atsSource: 'ashby',
        jobUrl: 'https://jobs.ashbyhq.com/linear/abc-123'
      });

      const validationError = minimalJob.validateSync();
      expect(validationError).toBeUndefined();
      expect(minimalJob.description).toBe('');
      expect(minimalJob.location).toBe('');
      expect(minimalJob.fitScore).toBeNull();
      expect(minimalJob.verdict).toBeNull();
      expect(minimalJob.matchingSkills).toEqual([]);
      expect(minimalJob.missingSkills).toEqual([]);
      expect(minimalJob.status).toBe('pending');
      expect(minimalJob.notified).toBe(false);
    });

    it('should fail if required fields are missing', () => {
      const job = new Job({});
      const err = job.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.title).toBeDefined();
      expect(err.errors.company).toBeDefined();
      expect(err.errors.atsSource).toBeDefined();
      expect(err.errors.jobUrl).toBeDefined();
    });
  });

  describe('2. Invalid atsSource Validation', () => {
    it('should reject unsupported atsSource values', () => {
      const invalidJob = new Job({
        ...validJobData,
        atsSource: 'workday' // Not in ['greenhouse', 'lever', 'ashby']
      });

      const err = invalidJob.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.atsSource).toBeDefined();
      expect(err.errors.atsSource.message).toContain('Invalid ATS source');
    });

    it('should accept valid atsSource values: greenhouse, lever, ashby', () => {
      ['greenhouse', 'lever', 'ashby'].forEach((source) => {
        const job = new Job({ ...validJobData, atsSource: source });
        expect(job.validateSync()).toBeUndefined();
      });
    });
  });

  describe('3. Invalid fitScore Validation', () => {
    it('should reject negative fitScore (< 0)', () => {
      const job = new Job({
        ...validJobData,
        fitScore: -5
      });

      const err = job.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.fitScore).toBeDefined();
      expect(err.errors.fitScore.message).toContain('Fit score cannot be less than 0');
    });

    it('should reject fitScore exceeding 100 (> 100)', () => {
      const job = new Job({
        ...validJobData,
        fitScore: 105
      });

      const err = job.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.fitScore).toBeDefined();
      expect(err.errors.fitScore.message).toContain('Fit score cannot be greater than 100');
    });

    it('should accept boundary values 0 and 100, and null', () => {
      const job0 = new Job({ ...validJobData, fitScore: 0 });
      const job100 = new Job({ ...validJobData, fitScore: 100 });
      const jobNull = new Job({ ...validJobData, fitScore: null });

      expect(job0.validateSync()).toBeUndefined();
      expect(job100.validateSync()).toBeUndefined();
      expect(jobNull.validateSync()).toBeUndefined();
    });
  });

  describe('4. Invalid status Validation', () => {
    it('should reject unsupported status values', () => {
      const job = new Job({
        ...validJobData,
        status: 'archived' // Not in ['pending', 'matched', 'ignored', 'applied']
      });

      const err = job.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
      expect(err.errors.status.message).toContain('Invalid status');
    });

    it('should accept supported status values: pending, matched, ignored, applied', () => {
      ['pending', 'matched', 'ignored', 'applied'].forEach((st) => {
        const job = new Job({ ...validJobData, status: st });
        expect(job.validateSync()).toBeUndefined();
      });
    });
  });

  describe('5. Duplicate jobUrl & Repository Handling', () => {
    it('should verify jobUrl has unique and index metadata configured on schema', () => {
      const jobUrlPath = Job.schema.path('jobUrl');
      expect(jobUrlPath.options.unique).toBe(true);
      expect(jobUrlPath.options.required).toBeDefined();
    });

    it('should verify compound indexes exist on schema', () => {
      const indexes = Job.schema.indexes();
      const hasStatusFitScore = indexes.some(
        ([fields]) => fields.status === 1 && fields.fitScore === -1
      );
      const hasNotifiedFitScore = indexes.some(
        ([fields]) => fields.notified === 1 && fields.fitScore === -1
      );
      const hasCompanyAtsSource = indexes.some(
        ([fields]) => fields.company === 1 && fields.atsSource === 1
      );

      expect(hasStatusFitScore).toBe(true);
      expect(hasNotifiedFitScore).toBe(true);
      expect(hasCompanyAtsSource).toBe(true);
    });

    it('createJobIfNotExists should catch duplicate key error (code 11000) and return existing record', async () => {
      const existingDoc = { _id: '507f1f77bcf86cd799439011', ...validJobData };

      // Mock Job.findOne & Job.create simulating duplicate key race condition
      const findOneSpy = jest.spyOn(Job, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existingDoc)
      });

      const duplicateError = new Error('E11000 duplicate key error collection');
      duplicateError.code = 11000;
      const createSpy = jest.spyOn(Job, 'create').mockRejectedValueOnce(duplicateError);

      const result = await jobRepository.createJobIfNotExists(validJobData);

      expect(result.isNew).toBe(false);
      expect(result.job._id).toBe('507f1f77bcf86cd799439011');

      findOneSpy.mockRestore();
      createSpy.mockRestore();
    });

    it('bulkInsertJobs should handle empty or null array safely', async () => {
      const result = await jobRepository.bulkInsertJobs([]);
      expect(result).toEqual({ total: 0, inserted: 0, duplicates: 0 });
    });

    it('bulkInsertJobs should execute bulkWrite with upsert operations', async () => {
      const bulkWriteSpy = jest.spyOn(Job, 'bulkWrite').mockResolvedValueOnce({
        upsertedCount: 2
      });

      const jobs = [
        validJobData,
        { ...validJobData, jobUrl: 'https://jobs.lever.co/netflix/9876' }
      ];

      const result = await jobRepository.bulkInsertJobs(jobs);

      expect(bulkWriteSpy).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(2);
      expect(result.inserted).toBe(2);
      expect(result.duplicates).toBe(0);

      bulkWriteSpy.mockRestore();
    });

    it('markJobsNotified should update multiple job records', async () => {
      const updateManySpy = jest.spyOn(Job, 'updateMany').mockResolvedValueOnce({
        modifiedCount: 3
      });

      const count = await jobRepository.markJobsNotified(['id1', 'id2', 'id3']);
      expect(count).toBe(3);
      expect(updateManySpy).toHaveBeenCalledWith(
        { _id: { $in: ['id1', 'id2', 'id3'] } },
        { $set: { notified: true } }
      );

      updateManySpy.mockRestore();
    });

    it('updateMatchResult should update fit score and verdict', async () => {
      const updatedMock = {
        _id: '507f1f77bcf86cd799439011',
        ...validJobData,
        fitScore: 92,
        verdict: 'Strong Match',
        status: 'matched'
      };

      const findByIdAndUpdateSpy = jest.spyOn(Job, 'findByIdAndUpdate').mockReturnValue({
        lean: jest.fn().mockResolvedValueOnce(updatedMock)
      });

      const res = await jobRepository.updateMatchResult('507f1f77bcf86cd799439011', {
        fitScore: 92,
        verdict: 'Strong Match',
        matchingSkills: ['Node.js', 'MongoDB'],
        missingSkills: [],
        status: 'matched'
      });

      expect(res.fitScore).toBe(92);
      expect(res.verdict).toBe('Strong Match');
      expect(res.status).toBe('matched');

      findByIdAndUpdateSpy.mockRestore();
    });
  });
});
