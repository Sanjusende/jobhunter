# AI-Powered Job Automation Agent

A production-grade, modular Node.js automation service designed to scrape career listings from ATS platforms (Greenhouse, Lever, Ashby), evaluate and rank candidate fit using Google Gemini AI, and dispatch automated top opportunity digests via email.

---

## 📌 Project Purpose

The **AI-Powered Job Automation Agent** streamlines the tech job search pipeline:
1. **Automated ATS Job Ingestion**: Fetches active positions from Greenhouse, Lever, and Ashby boards without manual searching.
2. **Persistent Storage & De-duplication**: Stores standardized, schema-validated job records in MongoDB with unique URL indexing and compound indexes.
3. **AI Semantic Matching**: Evaluates job descriptions against candidate resume profiles using Google Gemini AI to compute match scores, verdicts, and skill gap analyses.
4. **Digest Notifications**: Dispatches an email digest containing the top-fit opportunities matching customizable thresholds.
5. **Scheduled Automation**: Runs automatically via GitHub Actions or on-prem cron schedules.

---

## 🏛️ System Architecture

```
job-automation-agent/
├── src/
│   ├── config/
│   │   ├── candidateProfile.js       # Candidate background & skill configuration
│   │   ├── database.js               # Mongoose connection lifecycle & connection pooling
│   │   └── env.js                    # Environment parsing, type coercion, and validation
│   ├── models/
│   │   └── Job.js                    # Mongoose schema, validation rules, and compound indexes
│   ├── scrapers/
│   │   ├── ashby.js                  # Ashby ATS scraper & secondary location parser
│   │   ├── greenhouse.js             # Greenhouse ATS scraper & Cheerio HTML parser
│   │   ├── lever.js                  # Lever ATS scraper & multi-location resolver
│   │   └── index.js                  # Scrapers aggregator module
│   ├── services/
│   │   ├── aiMatcher.js              # Google Gemini AI matching & scoring engine
│   │   ├── emailService.js           # [NEW - Part 8] Responsive HTML email digest service (Nodemailer)
│   │   ├── jobIngestionService.js    # Unified ATS scraper orchestration service
│   │   └── jobRepository.js          # Data persistence, deduplication, bulk upserts & queries
│   ├── utils/
│   │   ├── delay.js                  # Asynchronous delay helper for rate-limiting
│   │   ├── errors.js                 # Standardized AppError and error formatting
│   │   └── logger.js                 # Structured JSON logger with automatic secret redaction
│   └── index.js                      # Express bootstrap, health check, and graceful shutdown
├── tests/
│   ├── aiMatcher.test.js             # Gemini AI scoring, rate-limiting & fallback tests
│   ├── ashby.test.js                 # Ashby scraper, location resolution & retry tests
│   ├── emailService.test.js          # [NEW - Part 8] Nodemailer email digest & transactional notification tests
│   ├── greenhouse.test.js            # Greenhouse scraper & HTML normalization tests
│   ├── health.test.js                # API health endpoint integration tests
│   ├── job.test.js                   # Schema validation, index verification & repository unit tests
│   ├── jobIngestionService.test.js   # Unified scraper orchestration & fault-isolation tests
│   ├── lever.test.js                 # Lever scraper & location resolver tests
│   └── utils.test.js                 # Utility & error serialization tests
├── .env.example                      # Environment configuration template
├── .gitignore                        # Git ignore rules for node_modules, secrets, and logs
├── package.json                      # Scripts and dependencies
└── README.md                         # Documentation
```

---

## 📧 Email Digest Service (Part 8)

The email digest service (`src/services/emailService.js`) builds and delivers responsive, mobile-friendly HTML email summaries of top matched opportunities via Nodemailer using Gmail SMTP or custom relay servers.

### Key Capabilities
- **Transactional Delivery**: Queries top unnotified matched jobs (`status: 'matched'`, `fitScore >= threshold`, `notified: false`) sorted by `fitScore` descending. Marks jobs `notified: true` **only after** verified email delivery.
- **Empty Digest Prevention**: If no new matching jobs exist, safely returns `{ sent: false, reason: "NO_ELIGIBLE_JOBS" }` without sending blank emails.
- **Responsive Email Design**: Beautiful cards compatible with Gmail, Apple Mail, Outlook, and mobile clients with score badges, skill chips, and direct application links.
- **HTML Sanitization & Safety**: Automatically escapes job titles, company names, and descriptions to prevent XSS and rendering breakages.
- **Plain-Text Fallback**: Generates clean plain-text alternatives for clients without HTML support.

---

## 🧠 AI Job Matching Engine (Part 7)

The AI Matching Engine (`src/services/aiMatcher.js`) leverages `@google/generative-ai` to compare pending job descriptions against candidate profiles (`src/config/candidateProfile.js`).

---

## 🔄 Unified ATS Ingestion Service (Part 6)

The orchestrator service (`src/services/jobIngestionService.js`) provides a single entry point `runAllScrapers()` to execute all configured ATS scrapers in sequential order:

1. **Greenhouse** (`fetchAllGreenhouseJobs`)
2. **Lever** (`fetchAllLeverJobs`)
3. **Ashby** (`fetchAllAshbyJobs`)

---

## 🗄️ Database Schema & Persistence (Part 2)

### Job Model (`src/models/Job.js`)

| Field | Type | Rules / Options | Description |
| :--- | :--- | :--- | :--- |
| `title` | `String` | Required, trimmed | Position title |
| `company` | `String` | Required, trimmed | Company name |
| `atsSource` | `String` | Required, enum: `greenhouse`, `lever`, `ashby` | Source ATS platform |
| `jobUrl` | `String` | Required, unique, indexed, trimmed | Canonical posting URL (used for deduplication) |
| `description`| `String` | Default: `""` | Cleaned job description text |
| `location` | `String` | Default: `""` | Work location (e.g. Remote, City) |
| `fitScore` | `Number` | Min: `0`, Max: `100`, Default: `null` | AI match fit score (0-100) |
| `verdict` | `String` | Enum: `Strong Match`, `Moderate Match`, `Low Match`, `null` | Evaluated fit verdict |
| `matchingSkills` | `[String]` | Default: `[]` | Identified relevant candidate skills |
| `missingSkills` | `[String]` | Default: `[]` | Missing or required candidate skills |
| `status` | `String` | Enum: `pending`, `matched`, `ignored`, `applied`, Default: `pending` | Pipeline status |
| `notified` | `Boolean` | Default: `false`, indexed | Whether job was included in an email digest |
| `createdAt` / `updatedAt` | `Date` | Managed via `timestamps: true` | Automatic ISO timestamps |

---

## 🚀 Getting Started

### 1. Installation

```bash
npm install
```

### 2. Environment Configuration

```bash
cp .env.example .env
```

Configure SMTP email and target companies in `.env`:
```env
# SMTP Configuration (e.g., Gmail App Password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-16-character-app-password
EMAIL_FROM="AI Job Hunter <your-email@gmail.com>"
EMAIL_TO=recipient@example.com

# Matching Limits
AI_MATCH_THRESHOLD=70
TOP_JOBS_LIMIT=5

# Target Companies
GREENHOUSE_COMPANIES=stripe,airbnb,canonical
LEVER_COMPANIES=spotify,netflix
ASHBY_COMPANIES=linear,notion,retool
```

---

## 🏃 Running the Application & Tests

### Run Automated Tests
```bash
npm test
```

### Run in Development Mode
```bash
npm run dev
```

### Verify Health Endpoint
```bash
curl http://localhost:5000/health
```

---

## 🔮 Roadmap

- [x] **Part 1**: Architecture Foundation, Express bootstrap, Logging & Health check
- [x] **Part 2**: MongoDB Job Model, Mongoose Schema, Compound Indexes & Repository Services
- [x] **Part 3**: Greenhouse ATS Scraper, Cheerio Sanitization & Duplicate Handling
- [x] **Part 4**: Lever ATS Scraper, Location Resolver & Description Assembly
- [x] **Part 5**: Ashby ATS Scraper, Secondary Location Parsing & Description Extraction
- [x] **Part 6**: Unified ATS Ingestion Orchestrator Service
- [x] **Part 7**: Google Gemini AI Semantic Evaluation & Fit Scoring
- [x] **Part 8**: Production-Grade Nodemailer Email Digest Delivery
- [ ] **Part 9**: GitHub Actions Scheduled Automation