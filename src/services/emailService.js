/**
 * Production-Grade Email Digest Service
 * Formats top-ranked matched jobs into responsive HTML digests, delivers them via Nodemailer (Gmail SMTP),
 * and transactionally marks notified jobs to prevent duplicate alerts.
 */

const nodemailer = require('nodemailer');
const config = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const jobRepository = require('./jobRepository');

const EMAIL_SUBJECT = 'AI Job Hunter — Top Matching Jobs';

/**
 * Escapes HTML entities to prevent injection and rendering bugs in email clients.
 * @param {string} [str=''] 
 * @returns {string} Sanitized string
 */
function escapeHtml(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Creates and validates a Nodemailer SMTP transporter.
 * @returns {import('nodemailer').Transporter}
 */
function createTransporter() {
  const { host, port, secure, user, password } = config.smtp;

  if (!host || !user || !password) {
    throw new AppError('SMTP configuration incomplete. Please set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD in .env', 500);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass: password
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  return transporter;
}

/**
 * Queries top unnotified jobs matching the minimum fit threshold.
 * 
 * @param {number} [limit] 
 * @param {number} [minFitScore] 
 * @returns {Promise<Array<Object>>}
 */
async function getTopMatchingJobs(
  limit = config.agent.topJobsLimit || 5,
  minFitScore = config.agent.aiMatchThreshold || 70
) {
  return jobRepository.findTopUnnotifiedMatchedJobs(limit, minFitScore);
}

/**
 * Generates an email-safe, responsive HTML template for the job digest.
 * @param {Array<Object>} jobs 
 * @param {string} [candidateName='Candidate'] 
 * @returns {string} Responsive HTML string
 */
function generateDigestHtml(jobs, candidateName = 'Candidate') {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const jobCards = jobs.map((job) => {
    const title = escapeHtml(job.title);
    const company = escapeHtml(job.company);
    const location = escapeHtml(job.location || 'Location Not Specified');
    const atsSource = escapeHtml(job.atsSource ? job.atsSource.toUpperCase() : 'ATS');
    const fitScore = job.fitScore || 0;
    const verdict = escapeHtml(job.verdict || 'Matched');
    const jobUrl = encodeURI(job.jobUrl || '#');

    // Score badge color
    const scoreColor = fitScore >= 80 ? '#10b981' : '#3b82f6';
    const scoreBg = fitScore >= 80 ? '#ecfdf5' : '#eff6ff';

    // Matching skills chips
    const matchingSkillsHtml = Array.isArray(job.matchingSkills) && job.matchingSkills.length > 0
      ? job.matchingSkills
          .map((s) => `<span style="display:inline-block;background-color:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:3px 8px;border-radius:12px;font-size:11px;margin:2px 4px 2px 0;font-weight:600;">✓ ${escapeHtml(s)}</span>`)
          .join('')
      : '<span style="color:#6b7280;font-size:12px;">None specified</span>';

    // Missing skills chips
    const missingSkillsHtml = Array.isArray(job.missingSkills) && job.missingSkills.length > 0
      ? job.missingSkills
          .map((s) => `<span style="display:inline-block;background-color:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:3px 8px;border-radius:12px;font-size:11px;margin:2px 4px 2px 0;font-weight:500;">△ ${escapeHtml(s)}</span>`)
          .join('')
      : '<span style="color:#10b981;font-size:12px;">Full Skill Coverage</span>';

    return `
      <!-- JOB CARD -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,0.05);overflow:hidden;">
        <tr>
          <td style="padding:20px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:top;">
                  <span style="display:inline-block;background:#f3f4f6;color:#4b5563;font-size:10px;font-weight:700;letter-spacing:0.5px;padding:2px 6px;border-radius:4px;margin-bottom:8px;">${atsSource}</span>
                  <h2 style="margin:0 0 4px 0;color:#111827;font-size:18px;font-weight:700;line-height:1.3;">${title}</h2>
                  <p style="margin:0 0 12px 0;color:#4b5563;font-size:14px;font-weight:500;">
                    <strong style="color:#1f2937;">${company}</strong> • <span>${location}</span>
                  </p>
                </td>
                <td align="right" style="vertical-align:top;width:90px;">
                  <div style="background:${scoreBg};border:1px solid ${scoreColor};border-radius:8px;padding:6px 10px;text-align:center;">
                    <div style="font-size:18px;font-weight:800;color:${scoreColor};line-height:1;">${fitScore}%</div>
                    <div style="font-size:10px;font-weight:600;color:${scoreColor};margin-top:2px;">${verdict}</div>
                  </div>
                </td>
              </tr>
            </table>

            <div style="border-top:1px solid #f3f4f6;margin:12px 0;padding-top:12px;">
              <div style="margin-bottom:8px;">
                <span style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Matching Skills:</span>
                <div>${matchingSkillsHtml}</div>
              </div>
              
              <div style="margin-bottom:16px;">
                <span style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Missing / Gap Skills:</span>
                <div>${missingSkillsHtml}</div>
              </div>

              <div>
                <a href="${jobUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;text-align:center;">
                  View & Apply &rarr;
                </a>
              </div>
            </div>
          </td>
        </tr>
      </table>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${EMAIL_SUBJECT}</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:30px 10px;">
        <tr>
          <td align="center">
            <!-- CONTAINER -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
              <!-- HEADER -->
              <tr>
                <td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:32px 28px;text-align:left;">
                  <div style="display:inline-block;background:#38bdf8;color:#0f172a;font-size:11px;font-weight:800;letter-spacing:1px;padding:3px 8px;border-radius:4px;text-transform:uppercase;margin-bottom:8px;">AI Career Intelligence</div>
                  <h1 style="margin:0 0 6px 0;color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">🎯 Top Matching Opportunities</h1>
                  <p style="margin:0;color:#94a3b8;font-size:13px;">Curated for <strong>${escapeHtml(candidateName)}</strong> • ${dateStr}</p>
                </td>
              </tr>

              <!-- BODY -->
              <tr>
                <td style="padding:28px 24px 12px 24px;background-color:#f8fafc;">
                  <p style="margin:0 0 20px 0;font-size:14px;color:#475569;line-height:1.5;">
                    Here are your top <strong>${jobs.length}</strong> matched tech opportunities scanned from Greenhouse, Lever, and Ashby boards, evaluated by Gemini AI against your skill profile.
                  </p>
                  
                  ${jobCards}
                </td>
              </tr>

              <!-- FOOTER -->
              <tr>
                <td style="background:#ffffff;border-top:1px solid #e2e8f0;padding:24px 28px;text-align:center;color:#64748b;font-size:12px;line-height:1.5;">
                  <p style="margin:0 0 6px 0;font-weight:600;color:#334155;">AI-Powered Job Automation Agent</p>
                  <p style="margin:0;">Automatically dispatched by your personal career agent. Powered by Gemini AI.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Generates an accessible plain-text fallback version of the email digest.
 * @param {Array<Object>} jobs 
 * @param {string} [candidateName='Candidate'] 
 * @returns {string} Plain-text email body
 */
function generateDigestPlainText(jobs, candidateName = 'Candidate') {
  const lines = [
    `AI Job Hunter — Top Matching Jobs`,
    `Curated for: ${candidateName}`,
    `Date: ${new Date().toLocaleDateString()}`,
    `=========================================\n`,
    `Found ${jobs.length} top matching opportunities for your profile:\n`
  ];

  jobs.forEach((job, index) => {
    lines.push(`[${index + 1}] ${job.title} @ ${job.company}`);
    lines.push(`    Location: ${job.location || 'Not specified'}`);
    lines.push(`    ATS Source: ${job.atsSource ? job.atsSource.toUpperCase() : 'ATS'}`);
    lines.push(`    Fit Score: ${job.fitScore || 0}% (${job.verdict || 'Matched'})`);
    lines.push(`    Matching Skills: ${(job.matchingSkills || []).join(', ') || 'None'}`);
    lines.push(`    Missing Skills: ${(job.missingSkills || []).join(', ') || 'None'}`);
    lines.push(`    Apply: ${job.jobUrl}`);
    lines.push(`-----------------------------------------`);
  });

  lines.push(`\nDispatched automatically by AI Job Automation Agent.`);
  return lines.join('\n');
}

/**
 * Executes the complete email digest workflow transactionally:
 * 1. Queries eligible matched jobs (status=matched, fitScore >= threshold, notified=false)
 * 2. If none exist, aborts without sending empty email
 * 3. Builds and dispatches responsive email via Nodemailer
 * 4. Marks delivered jobs as notified=true ONLY after verified delivery
 * 
 * @param {Object} [options={}]
 * @param {number} [options.limit] - Custom job limit
 * @param {Object} [options.transporter] - Injected transporter (useful for testing)
 * @param {string} [options.candidateName] - Recipient candidate name
 * @returns {Promise<{ sent: boolean, jobsSent?: number, jobIds?: string[], reason?: string, error?: string }>}
 */
async function sendJobDigest(options = {}) {
  const { limit, transporter: injectedTransporter, candidateName = 'Candidate' } = options;

  logger.info('Initiating Job Digest email dispatch workflow...');

  // 1. Find eligible jobs
  const jobs = await getTopMatchingJobs(limit);

  if (!jobs || jobs.length === 0) {
    logger.info('No eligible unnotified matched jobs found for digest email. Skipping dispatch.');
    return {
      sent: false,
      reason: 'NO_ELIGIBLE_JOBS'
    };
  }

  logger.info(`Found ${jobs.length} eligible matched jobs for email digest.`);

  const htmlContent = generateDigestHtml(jobs, candidateName);
  const textContent = generateDigestPlainText(jobs, candidateName);
  const recipientEmail = config.smtp.emailTo || config.smtp.user;
  const fromEmail = config.smtp.emailFrom || `"Job Automation Agent" <${config.smtp.user}>`;

  const mailOptions = {
    from: fromEmail,
    to: recipientEmail,
    subject: EMAIL_SUBJECT,
    html: htmlContent,
    text: textContent
  };

  // 2. Dispatch Email
  const transporter = injectedTransporter || createTransporter();

  try {
    logger.info(`Sending job digest email to: ${recipientEmail}...`);
    const info = await transporter.sendMail(mailOptions);
    logger.info('Job digest email delivered successfully', {
      messageId: info ? info.messageId : 'delivered',
      recipient: recipientEmail,
      count: jobs.length
    });

    // 3. Mark delivered jobs as notified transactionally AFTER delivery
    const jobIds = jobs.map((j) => j._id);
    await jobRepository.markJobsNotified(jobIds);

    return {
      sent: true,
      jobsSent: jobs.length,
      jobIds
    };
  } catch (error) {
    logger.error('Failed to deliver job digest email. Jobs will remain unnotified for future retry.', {
      error: error.message
    });

    throw error;
  }
}

module.exports = {
  createTransporter,
  getTopMatchingJobs,
  generateDigestHtml,
  generateDigestPlainText,
  sendJobDigest,
  escapeHtml,
  EMAIL_SUBJECT
};
