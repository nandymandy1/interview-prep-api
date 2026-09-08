import { body, param, query } from 'express-validator';
import { MAX_PAGE_LIMIT } from '@/common/types/pagination.type';

export const listKitsValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be an integer >= 1').toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: MAX_PAGE_LIMIT })
    .withMessage(`Limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`)
    .toInt(),
];

export const createKitValidator = [
  body('jd')
    .isString()
    .trim()
    .isLength({ min: 1, max: 50000 })
    .withMessage('A job description between 1 and 50000 characters is required'),
  body('companyUrl')
    .trim()
    .notEmpty()
    .withMessage('A company URL is required')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('A valid http(s) company URL is required'),
  body('days')
    .isInt({ min: 1, max: 60 })
    .withMessage('Days must be an integer between 1 and 60')
    .toInt(),
];

export const kitIdParamValidator = [
  param('kitId').isMongoId().withMessage('A valid kit id is required'),
];

export const recordPracticeValidator = [
  ...kitIdParamValidator,
  param('flashcardId').isString().trim().notEmpty().withMessage('A valid flashcard id is required'),
  body('confidence')
    .isInt({ min: 1, max: 5 })
    .withMessage('Confidence must be an integer between 1 and 5')
    .toInt(),
];
