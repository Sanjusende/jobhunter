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
│   │   ├── env.js               # Environment parsing, type coercion, and validation
│   │   └── database.js          # Mongoose connection lifecycle & connection pooling
│   ├── models/
│   │   └── Job.js               # Mongoose schema, validation rules, and compound indexes
│   ├── scrapers/
│   │   ├── greenhouse.js        # [Part 3] Greenhouse ATS scraper & Cheerio HTML parser
│   │   ├── lever.js             # [NEW - Part 4] Lever ATS scraper & multi-location resolver
│   │   └── index.js             # Scrapers aggregator module
│   ├── services/
│   │   └── jobRepository.js     # Data persistence, deduplication, bulk upserts & queries
│   ├── utils/
│   │   ├── delay.js             # Asynchronous delay helper for rate-limiting
│   │   ├── errors.js            # Standardized AppError and error formatting
│   │   └── logger.js            # Structured JSON logger with automatic secret redaction
│   └── index.js                 # Express bootstrap, health check, and graceful shutdown
├── tests/
│   ├── greenhouse.test.js       # Greenhouse scraper & HTML normalization tests
│   ├── health.test.js           # API health endpoint integration tests
│   ├── job.test.js              # Schema validation, index verification & repository unit tests
│   ├── lever.test.js            # [NEW - Part 4] Lever scraper, location & description assembly tests
│   └── utils.test.js            # Utility & error serialization tests
├── .env.example                 # Environment configuration template
├── .gitignore                   # Git ignore rules for node_modules, secrets, and logs
├── package.json                 # Scripts and dependencies
└── README.md                    # Documentation
```

---

## 🔌 ATS Ingestion Scrapers

### 1. Greenhouse Scraper (`src/scrapers/greenhouse.js`)
- **Endpoint**: `GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true`
- **Sanitization**: Cheerio HTML parser strips scripts/styles and formats readable text.
- **Batch Processing**: Configured via `GREENHOUSE_COMPANIES=stripe,airbnb,canonical`.

### 2. Lever Scraper (`src/scrapers/lever.js`)
- **Endpoint**: `GET https://api.lever.co/v0/postings/{company}?mode=json`
- **Location Resolution**: Handles `categories.location`, `categories.allLocations` arrays, and `workplaceType` tags (Remote, Hybrid, Onsite).
- **Description Assembly**: Intelligently combines job overview, structured requirement lists (`lists`), and compensation notes (`additional`).
- **Batch Processing**: Configured via `LEVER_COMPANIES=spotify,netflix`.

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

Configure target companies in `.env`:
```env
GREENHOUSE_COMPANIES=stripe,airbnb,canonical
LEVER_COMPANIES=spotify,netflix
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
- [ ] **Part 5**: Ashby ATS Scraper
- [ ] **Part 6**: Gemini AI Semantic Evaluation & Fit Scoring
- [ ] **Part 7**: Nodemailer Email Digest Delivery
- [ ] **Part 8**: GitHub Actions Scheduled Automation