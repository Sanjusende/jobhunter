const {
  sendJobDigest,
  getTopMatchingJobs,
  generateDigestHtml,
  generateDigestPlainText,
  escapeHtml,
  createTransporter,
  EMAIL_SUBJECT
} = require('../src/services/emailService');
const jobRepository = require('../src/services/jobRepository');
const config = require('../src/config/env');

describe('Email Digest Service (Nodemailer)', () => {
  const sampleMatchedJobs = [
    {
      _id: 'job-id-101',
      title: 'Senior Full Stack Engineer',
      company: 'Linear',
      atsSource: 'ashby',
      location: 'Remote',
      fitScore: 92,
      verdict: 'Strong Match',
      matchingSkills: ['React', 'Node.js', 'TypeScript', 'MongoDB'],
      missingSkills: ['GraphQL'],
      jobUrl: 'https://jobs.ashbyhq.com/linear/job-101',
      notified: false
    },
    {
      _id: 'job-id-102',
      title: 'Backend Engineer',
      company: 'Stripe',
      atsSource: 'greenhouse',
      location: 'San Francisco, CA',
      fitScore: 86,
      verdict: 'Strong Match',
      matchingSkills: ['Node.js', 'Express', 'MongoDB'],
      missingSkills: ['Kafka'],
      jobUrl: 'https://boards.greenhouse.io/stripe/jobs/102',
      notified: false
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('HTML Sanitization (escapeHtml)', () => {
    it('should escape HTML characters to prevent XSS and email rendering breaks', () => {
      const unsafe = '<script>alert("hack")</script> & "Dangerous" \'Quote\'';
      const safe = escapeHtml(unsafe);
      expect(safe).not.toContain('<script>');
      expect(safe).toContain('&lt;script&gt;');
      expect(safe).toContain('&amp;');
      expect(safe).toContain('&quot;Dangerous&quot;');
      expect(safe).toContain('&#39;Quote&#39;');
    });

    it('should return empty string for null or non-string inputs', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml(1234)).toBe('');
    });
  });

  describe('Template Generation', () => {
    it('should generate responsive HTML email with job details and apply links', () => {
      const html = generateDigestHtml(sampleMatchedJobs, 'Sanjay Sende');
      expect(html).toContain('Top Matching Opportunities');
      expect(html).toContain('Sanjay Sende');
      expect(html).toContain('Senior Full Stack Engineer');
      expect(html).toContain('Linear');
      expect(html).toContain('92%');
      expect(html).toContain('Strong Match');
      expect(html).toContain('✓ React');
      expect(html).toContain('△ GraphQL');
      expect(html).toContain('https://jobs.ashbyhq.com/linear/job-101');
    });

    it('should generate clean plain-text fallback content', () => {
      const text = generateDigestPlainText(sampleMatchedJobs, 'Sanjay Sende');
      expect(text).toContain('AI Job Hunter — Top Matching Jobs');
      expect(text).toContain('Senior Full Stack Engineer @ Linear');
      expect(text).toContain('Fit Score: 92% (Strong Match)');
      expect(text).toContain('Apply: https://jobs.ashbyhq.com/linear/job-101');
    });
  });

  describe('sendJobDigest Workflow', () => {
    it('1. should find eligible jobs, send email, and mark jobs as notified', async () => {
      const findSpy = jest.spyOn(jobRepository, 'findTopUnnotifiedMatchedJobs').mockResolvedValueOnce(sampleMatchedJobs);
      const markSpy = jest.spyOn(jobRepository, 'markJobsNotified').mockResolvedValueOnce(2);

      const mockTransporter = {
        sendMail: jest.fn().mockResolvedValueOnce({ messageId: 'test-message-id-12345' })
      };

      const result = await sendJobDigest({
        limit: 5,
        transporter: mockTransporter,
        candidateName: 'Sanjay Sende'
      });

      expect(findSpy).toHaveBeenCalledWith(5, expect.any(Number));
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: EMAIL_SUBJECT,
          html: expect.stringContaining('Senior Full Stack Engineer'),
          text: expect.stringContaining('Linear')
        })
      );
      expect(markSpy).toHaveBeenCalledWith(['job-id-101', 'job-id-102']);
      expect(result).toEqual({
        sent: true,
        jobsSent: 2,
        jobIds: ['job-id-101', 'job-id-102']
      });

      findSpy.mockRestore();
      markSpy.mockRestore();
    });

    it('2. should not send email if no eligible jobs exist', async () => {
      const findSpy = jest.spyOn(jobRepository, 'findTopUnnotifiedMatchedJobs').mockResolvedValueOnce([]);
      const mockTransporter = { sendMail: jest.fn() };

      const result = await sendJobDigest({ transporter: mockTransporter });

      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
      expect(result).toEqual({
        sent: false,
        reason: 'NO_ELIGIBLE_JOBS'
      });

      findSpy.mockRestore();
    });

    it('3. should NOT mark jobs as notified if email delivery throws an error', async () => {
      const findSpy = jest.spyOn(jobRepository, 'findTopUnnotifiedMatchedJobs').mockResolvedValueOnce(sampleMatchedJobs);
      const markSpy = jest.spyOn(jobRepository, 'markJobsNotified');

      const mockTransporter = {
        sendMail: jest.fn().mockRejectedValueOnce(new Error('SMTP Connection Refused (ECONNREFUSED)'))
      };

      await expect(
        sendJobDigest({ transporter: mockTransporter })
      ).rejects.toThrow('SMTP Connection Refused');

      // Crucial: database must NOT be marked notified so jobs can be retried on next execution
      expect(markSpy).not.toHaveBeenCalled();

      findSpy.mockRestore();
      markSpy.mockRestore();
    });
  });

  describe('createTransporter configuration validation', () => {
    it('should throw error if SMTP settings are missing', () => {
      const originalHost = config.smtp.host;
      config.smtp.host = '';

      expect(() => createTransporter()).toThrow('SMTP configuration incomplete');

      config.smtp.host = originalHost;
    });
  });
});
