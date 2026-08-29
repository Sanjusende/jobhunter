/**
 * Mongoose Schema & Model for Job Postings
 * Represents jobs scraped from ATS boards (Greenhouse, Lever, Ashby)
 * and enriched with AI evaluation scores and notification status.
 */

const mongoose = require('mongoose');

const ATS_SOURCES = ['greenhouse', 'lever', 'ashby'];
const VERDICTS = ['Strong Match', 'Moderate Match', 'Low Match', null];
const STATUSES = ['pending', 'matched', 'ignored', 'applied'];

const jobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true
    },
    company: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true
    },
    atsSource: {
      type: String,
      required: [true, 'ATS source is required'],
      enum: {
        values: ATS_SOURCES,
        message: 'Invalid ATS source: {VALUE}. Must be one of: ' + ATS_SOURCES.join(', ')
      },
      lowercase: true,
      trim: true
    },
    jobUrl: {
      type: String,
      required: [true, 'Job URL is required'],
      unique: true,
      index: true,
      trim: true
    },
    description: {
      type: String,
      default: '',
      trim: true
    },
    location: {
      type: String,
      default: '',
      trim: true
    },
    fitScore: {
      type: Number,
      default: null,
      min: [0, 'Fit score cannot be less than 0'],
      max: [100, 'Fit score cannot be greater than 100']
    },
    verdict: {
      type: String,
      enum: {
        values: VERDICTS,
        message: 'Invalid verdict: {VALUE}'
      },
      default: null
    },
    matchingSkills: {
      type: [String],
      default: []
    },
    missingSkills: {
      type: [String],
      default: []
    },
    status: {
      type: String,
      enum: {
        values: STATUSES,
        message: 'Invalid status: {VALUE}. Must be one of: ' + STATUSES.join(', ')
      },
      default: 'pending',
      index: true
    },
    notified: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true
  }
);

// Compound indexes for optimized querying and ranking
jobSchema.index({ status: 1, fitScore: -1 });
jobSchema.index({ notified: 1, fitScore: -1 });
jobSchema.index({ company: 1, atsSource: 1 });

const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);

module.exports = {
  Job,
  ATS_SOURCES,
  VERDICTS,
  STATUSES
};
