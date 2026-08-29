const {
  matchJob,
  matchPendingJobs,
  extractAndParseJSON,
  validateAndNormalizeEvaluation,
  isTransientError
} = require('../src/services/aiMatcher');
const jobRepository = require('../src/services/jobRepository');
const config = require('../src/config/env');

describe('AI Matcher Service (Gemini Integration)', () => {
  const sampleJob = {
    _id: '507f1f77bcf86cd799439011',
    title: 'Senior Backend Engineer',
    company: 'Stripe',
    atsSource: 'greenhouse',
    location: 'Remote',
    description: 'We are seeking a senior engineer with Node.js, MongoDB, and API architecture skills.'
  };

  const sampleProfile = {
    name: 'Candidate',
    summary: 'Senior Node.js & MongoDB engineer',
    skills: ['Node.js', 'MongoDB', 'Express', 'Architecture']
  };

  describe('JSON Extraction & Normalization', () => {
    it('should parse strict clean JSON', () => {
      const raw = '{"fitScore": 88, "verdict": "Strong Match", "matchingSkills": ["Node.js"], "missingSkills": []}';
      const parsed = extractAndParseJSON(raw);
      expect(parsed.fitScore).toBe(88);
      expect(parsed.verdict).toBe('Strong Match');
    });

    it('4. Malformed JSON Recovery: should strip markdown code fences', () => {
      const raw = '```json\n{"fitScore": 85, "verdict": "Strong Match", "matchingSkills": ["MongoDB"], "missingSkills": []}\n```';
      const parsed = extractAndParseJSON(raw);
      expect(parsed.fitScore).toBe(85);
    });

    it('4. Malformed JSON: should extract JSON when wrapped in conversational text', () => {
      const raw = 'Here is the evaluation:\n{"fitScore": 75, "verdict": "Moderate Match", "matchingSkills": ["Node.js"], "missingSkills": []}\nHope this helps!';
      const parsed = extractAndParseJSON(raw);
      expect(parsed.fitScore).toBe(75);
    });

    it('5. Missing Fields: should normalize missing or invalid fields gracefully', () => {
      const incomplete = {
        fitScore: '92.4', // Non-integer string
        matchingSkills: null,
        missingSkills: undefined
      };

      const normalized = validateAndNormalizeEvaluation(incomplete);
      expect(normalized.fitScore).toBe(92);
      expect(normalized.verdict).toBe('Strong Match'); // Deterministically derived from score >= 80
      expect(normalized.matchingSkills).toEqual([]);
      expect(normalized.missingSkills).toEqual([]);
      expect(normalized.reasoning).toBe('No reasoning provided.');
    });

    it('5. Out of bounds fitScore: should clamp fitScore between 0 and 100', () => {
      expect(validateAndNormalizeEvaluation({ fitScore: 150 }).fitScore).toBe(100);
      expect(validateAndNormalizeEvaluation({ fitScore: -20 }).fitScore).toBe(0);
    });
  });

  describe('matchJob evaluations with mocked Gemini model', () => {
    it('1. Strong Match: should return normalized strong match evaluation', async () => {
      const mockModel = {
        generateContent: jest.fn().mockResolvedValue({
          response: {
            text: () => JSON.stringify({
              fitScore: 90,
              verdict: 'Strong Match',
              matchingSkills: ['Node.js', 'MongoDB', 'Express'],
              missingSkills: [],
              reasoning: 'Candidate satisfies all principal technical and experience requirements.'
            })
          }
        })
      };

      const result = await matchJob(sampleJob, sampleProfile, mockModel);

      expect(mockModel.generateContent).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        fitScore: 90,
        verdict: 'Strong Match',
        matchingSkills: ['Node.js', 'MongoDB', 'Express'],
        missingSkills: [],
        reasoning: 'Candidate satisfies all principal technical and experience requirements.'
      });
    });

    it('2. Moderate Match: should return normalized moderate match evaluation', async () => {
      const mockModel = {
        generateContent: jest.fn().mockResolvedValue({
          response: {
            text: () => JSON.stringify({
              fitScore: 72,
              verdict: 'Moderate Match',
              matchingSkills: ['Node.js'],
              missingSkills: ['Kubernetes'],
              reasoning: 'Good backend skills, but lacks Kubernetes container orchestration experience.'
            })
          }
        })
      };

      const result = await matchJob(sampleJob, sampleProfile, mockModel);
      expect(result.fitScore).toBe(72);
      expect(result.verdict).toBe('Moderate Match');
      expect(result.missingSkills).toEqual(['Kubernetes']);
    });

    it('3. Low Match: should return normalized low match evaluation', async () => {
      const mockModel = {
        generateContent: jest.fn().mockResolvedValue({
          response: {
            text: () => JSON.stringify({
              fitScore: 40,
              verdict: 'Low Match',
              matchingSkills: [],
              missingSkills: ['Rust', 'Solana', 'C++'],
              reasoning: 'Candidate stack does not align with blockchain low-level systems requirements.'
            })
          }
        })
      };

      const result = await matchJob(sampleJob, sampleProfile, mockModel);
      expect(result.fitScore).toBe(40);
      expect(result.verdict).toBe('Low Match');
    });

    it('6. Rate Limit (429): should retry with backoff and succeed upon subsequent attempt', async () => {
      const rateLimitError = new Error('Resource has been exhausted (e.g. check quota) 429');
      rateLimitError.status = 429;

      const mockModel = {
        generateContent: jest.fn()
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({
            response: {
              text: () => JSON.stringify({
                fitScore: 82,
                verdict: 'Strong Match',
                matchingSkills: ['Node.js'],
                missingSkills: [],
                reasoning: 'Strong candidate after retry.'
              })
            }
          })
      };

      const result = await matchJob(sampleJob, sampleProfile, mockModel);

      expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
      expect(result.fitScore).toBe(82);
    });

    it('7. Network Failure: should retry transient network errors and succeed', async () => {
      const networkError = new Error('fetch failed: ETIMEDOUT');

      const mockModel = {
        generateContent: jest.fn()
          .mockRejectedValueOnce(networkError)
          .mockResolvedValueOnce({
            response: {
              text: () => JSON.stringify({
                fitScore: 80,
                verdict: 'Strong Match',
                matchingSkills: ['Node.js'],
                missingSkills: [],
                reasoning: 'Recovered from timeout.'
              })
            }
          })
      };

      const result = await matchJob(sampleJob, sampleProfile, mockModel);

      expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
      expect(result.fitScore).toBe(80);
    });
  });

  describe('matchPendingJobs Batch Processing', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should process pending jobs, update DB with matched status when score >= threshold', async () => {
      const pendingJobs = [
        { _id: 'job-1', title: 'Senior Backend Engineer', company: 'Stripe' },
        { _id: 'job-2', title: 'Data Analyst', company: 'Linear' }
      ];

      const findPendingSpy = jest.spyOn(jobRepository, 'findPendingJobs').mockResolvedValueOnce(pendingJobs);
      const updateMatchSpy = jest.spyOn(jobRepository, 'updateMatchResult')
        .mockResolvedValueOnce({ _id: 'job-1', status: 'matched' })
        .mockResolvedValueOnce({ _id: 'job-2', status: 'ignored' });

      // Mock model to return strong match for job 1 (85) and low match for job 2 (40)
      const mockModel = {
        generateContent: jest.fn()
          .mockResolvedValueOnce({
            response: {
              text: () => JSON.stringify({
                fitScore: 85,
                verdict: 'Strong Match',
                matchingSkills: ['Node.js'],
                missingSkills: [],
                reasoning: 'Strong fit.'
              })
            }
          })
          .mockResolvedValueOnce({
            response: {
              text: () => JSON.stringify({
                fitScore: 40,
                verdict: 'Low Match',
                matchingSkills: [],
                missingSkills: ['SQL', 'Tableau'],
                reasoning: 'Low fit.'
              })
            }
          })
      };

      const summary = await matchPendingJobs(10, sampleProfile, mockModel);

      expect(findPendingSpy).toHaveBeenCalledWith(10);
      expect(updateMatchSpy).toHaveBeenCalledTimes(2);
      expect(updateMatchSpy).toHaveBeenNthCalledWith(1, 'job-1', {
        fitScore: 85,
        verdict: 'Strong Match',
        matchingSkills: ['Node.js'],
        missingSkills: [],
        status: 'matched'
      });
      expect(updateMatchSpy).toHaveBeenNthCalledWith(2, 'job-2', {
        fitScore: 40,
        verdict: 'Low Match',
        matchingSkills: [],
        missingSkills: ['SQL', 'Tableau'],
        status: 'ignored'
      });

      expect(summary).toEqual({
        totalProcessed: 2,
        matched: 1,
        ignored: 1,
        failed: 0,
        results: expect.any(Array)
      });

      findPendingSpy.mockRestore();
      updateMatchSpy.mockRestore();
    });

    it('should return empty summary when no pending jobs are available', async () => {
      const findPendingSpy = jest.spyOn(jobRepository, 'findPendingJobs').mockResolvedValueOnce([]);

      const summary = await matchPendingJobs(10, sampleProfile, null);

      expect(summary).toEqual({
        totalProcessed: 0,
        matched: 0,
        ignored: 0,
        failed: 0,
        results: []
      });

      findPendingSpy.mockRestore();
    });
  });
});
