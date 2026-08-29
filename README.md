# AI-Powered Job Automation Agent

A production-grade, modular Node.js automation service designed to scrape career listings from ATS platforms (Greenhouse, Lever, Ashby), evaluate and rank candidate fit using Google Gemini AI, and dispatch automated top opportunity digests via email.

---

## 📌 Project Purpose

The **AI-Powered Job Automation Agent** streamlines the modern tech job search:
1. **Automated ATS Job Ingestion**: Fetches active positions from Greenhouse, Lever, and Ashby boards without manual searching.
2. **Persistent Storage & De-duplication**: Stores standardized job records in MongoDB.
3. **AI Semantic Matching**: Evaluates job descriptions against a candidate resume profile using Google Gemini AI to compute match scores and rationale.
4. **Digest Notifications**: Dispatches an email digest containing the top-fit opportunities matching customizable thresholds.
5. **Scheduled Automation**: Runs automatically via GitHub Actions or on-prem cron schedules.

---

## 🏛️ System Architecture (Part 1 Foundation)

```
job-automation-agent/
├── src/
│   ├── config/
│   │   ├── env.js          # Environment parsing, type coercion, and validation
│   │   └── database.js     # Mongoose connection lifecycle & connection pooling
│   ├── models/             # [Future] Mongoose schemas (Job, CandidateProfile, MatchResult)
│   ├── scrapers/           # [Future] ATS scrapers (Greenhouse, Lever, Ashby)
│   ├── services/           # [Future] AI matching, ranking, and email delivery
│   ├── utils/
│   │   ├── logger.js       # Structured JSON logger with automatic secret redaction
│   │   ├── delay.js        # Asynchronous delay helper for rate-limiting
│   │   └── errors.js       # Standardized AppError and error formatting
│   └── index.js            # Express bootstrap, health check, and graceful shutdown
├── .env.example            # Environment configuration template
├── .gitignore              # Git ignore rules for node_modules, secrets, and logs
├── package.json            # Scripts and dependencies
└── README.md               # Documentation
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **MongoDB**: Local MongoDB instance (`mongodb://localhost:27017`) or MongoDB Atlas cluster
- **npm**: `v9.0.0` or higher

### 1. Installation

Clone or open the repository and install all dependencies:

```bash
npm install
```

### 2. Environment Configuration

Copy the sample environment file to create `.env`:

```bash
cp .env.example .env
```

Edit `.env` to configure your settings:

```env
# Server Configuration
NODE_ENV=development
PORT=5000

# MongoDB Configuration
MONGO_URI=mongodb://localhost:27017/job-automation-agent

# Google Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash

# SMTP Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_FROM="Job Agent <your-email@gmail.com>"
EMAIL_TO=recipient@example.com

# Scraper & Matching Controls
REQUEST_TIMEOUT_MS=15000
GREENHOUSE_COMPANIES=stripe,airbnb,dropbox
LEVER_COMPANIES=netflix,spotify
ASHBY_COMPANIES=notion,linear

AI_MATCH_THRESHOLD=70
TOP_JOBS_LIMIT=5

# Logging Level (error, warn, info, debug)
LOG_LEVEL=info
```

---

## 🏃 Running the Application

### Development Mode (with hot reloading)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

### Linting & Tests
```bash
npm run lint
npm test
```

---

## 🔍 Health Check Endpoint

Verify the server is running and healthy:

```bash
curl http://localhost:5000/health
```

**Expected Response (`200 OK`):**
```json
{
  "success": true,
  "service": "ai-job-automation-agent",
  "status": "healthy"
}
```

---

## 🛡️ Production & Operational Features

- **Secret Redaction**: Structured logger automatically masks passwords, tokens, and API keys.
- **Fail-Fast Configuration**: Validates environment variables at boot with clear error diagnostics.
- **Graceful Shutdown**: Traps `SIGINT` and `SIGTERM` signals to close active HTTP listeners and cleanly disconnect from MongoDB before exiting.
- **Process Safety**: Catches unhandled promise rejections and uncaught exceptions to prevent silent process failures.

---

## 🔮 Roadmap (Future Modules)

- [ ] **Part 2 - ATS Scrapers**: Implement scrapers for Greenhouse API, Lever API, and Ashby JSON endpoints with Puppeteer fallback.
- [ ] **Part 3 - Data Models & Persistence**: Mongoose schemas for job listings, company tracking, and deduplication logic.
- [ ] **Part 4 - Gemini AI Matcher**: Semantic resume-to-JD evaluation, fit scoring, and bullet-point match rationale.
- [ ] **Part 5 - Email Notification Service**: Responsive HTML email templates with Nodemailer for Top-5 daily digests.
- [ ] **Part 6 - CI/CD & Automation**: GitHub Actions workflow for scheduled headless execution.
