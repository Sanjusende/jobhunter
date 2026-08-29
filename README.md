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
│   │   ├── env.js                    # Environment parsing, type coercion, and validation
│   │   └── database.js               # Mongoose connection lifecycle & connection pooling
│   ├── models/
│   │   └── Job.js                    # Mongoose schema, validation rules, and compound indexes
│   ├── scrapers/
│   │   ├── greenhouse.js             # [Part 3] Greenhouse ATS scraper & Cheerio HTML parser
│   │   ├── lever.js                  # [Part 4] Lever ATS scraper & multi-location resolver
│   │   ├── ashby.js                  # [Part 5] Ashby ATS scraper & secondary location parser
│   │   └── index.js                  # Scrapers aggregator module
│   ├── services/
│   │   ├── jobIngestionService.js    # [NEW - Part 6] Unified ATS scraper orchestration service
│   │   └── jobRepository.js          # Data persistence, deduplication, bulk upserts & queries
│   ├── utils/
│   │   ├── delay.js                  # Asynchronous delay helper for rate-limiting
│   │   ├── errors.js                 # Standardized AppError and error formatting
│   │   └── logger.js                 # Structured JSON logger with automatic secret redaction
│   └── index.js                      # Express bootstrap, health check, and graceful shutdown
├── tests/
│   ├── ashby.test.js                 # Ashby scraper, location resolution & retry tests
│   ├── greenhouse.test.js            # Greenhouse scraper & HTML normalization tests
│   ├── health.test.js                # API health endpoint integration tests
│   ├── job.test.js                   # Schema validation, index verification & repository unit tests
│   ├── jobIngestionService.test.js   # [NEW - Part 6] Unified scraper orchestration & fault-isolation tests
│   ├── lever.test.js                 # Lever scraper & location resolver tests
│   └── utils.test.js                 # Utility & error serialization tests
├── .env.example                      # Environment configuration template
├── .gitignore                        # Git ignore rules for node_modules, secrets, and logs
├── package.json                      # Scripts and dependencies
└── README.md                         # Documentation
```

---

## 🔄 Unified ATS Ingestion Service (Part 6)

The orchestrator service (`src/services/jobIngestionService.js`) provides a single entry point `runAllScrapers()` to execute all configured ATS scrapers in sequential order:

1. **Greenhouse** (`fetchAllGreenhouseJobs`)
2. **Lever** (`fetchAllLeverJobs`)
3. **Ashby** (`fetchAllAshbyJobs`)

### Key Characteristics
- **Sequential Execution**: Avoids network congestion while preserving rate-limit boundaries.
- **Platform Fault-Isolation**: An unhandled exception or network outage on one ATS platform does not stop execution of subsequent platforms.
- **Aggregated Pipeline Metrics**: Returns comprehensive summary statistics for downstream processors.

#### Orchestration Output Format
```json
{
  "greenhouse": {
    "totalCompanies": 3,
    "successfulCompanies": 3,
    "totalJobsFetched": 150,
    "totalJobsInserted": 20,
    "totalDuplicatesSkipped": 130
  },
  "lever": {
    "companiesProcessed": 2,
    "jobsFetched": 89,
    "jobsInserted": 12,
    "duplicates": 77,
    "failures": 0
  },
  "ashby": {
    "companiesProcessed": 2,
    "jobsFetched": 35,
    "jobsInserted": 5,
    "duplicates": 30,
    "failures": 0
  },
  "totalFetched": 274,
  "totalInserted": 37,
  "totalDuplicates": 237,
  "totalFailures": 0
}
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

### 3. Ashby Scraper (`src/scrapers/ashby.js`)
- **Endpoint**: `GET https://api.ashbyhq.com/posting-api/job-board/{company}`
- **Location & Remote Parsing**: Combines primary location, `secondaryLocations` arrays, and `isRemote` flags.
- **Description Handling**: Sanitizes `descriptionHtml` and falls back cleanly to `descriptionPlain` or `description`.
- **Batch Processing**: Configured via `ASHBY_COMPANIES=linear,notion,retool`.

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
- [ ] **Part 7**: Gemini AI Semantic Evaluation & Fit Scoring
- [ ] **Part 8**: Nodemailer Email Digest Delivery
- [ ] **Part 9**: GitHub Actions Scheduled Automation