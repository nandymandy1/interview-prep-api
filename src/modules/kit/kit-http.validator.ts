import { body, header, param, query } from 'express-validator';
import { MAX_PAGE_LIMIT } from '@/common/types/pagination.type';

export const idempotencyKeyValidator = [
  header('Idempotency-Key')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 128 })
    .withMessage('Idempotency-Key must be a non-empty string up to 128 characters'),
];

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

const questionIdParamValidator = [
  param('questionId').isString().trim().notEmpty().withMessage('A valid question id is required'),
];

const flashcardIdParamValidator = [
  param('flashcardId').isString().trim().notEmpty().withMessage('A valid flashcard id is required'),
];

export const updateQuestionValidator = [
  ...kitIdParamValidator,
  ...questionIdParamValidator,
  body('prompt')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Prompt must not be empty'),
  body('answer_outline')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Answer outline must not be empty'),
  body('category')
    .optional()
    .isIn(['technical', 'behavioural', 'system-design', 'company-fit'])
    .withMessage('Category must be a valid question category'),
  body('difficulty')
    .optional()
    .isInt({ min: 1, max: 3 })
    .withMessage('Difficulty must be an integer between 1 and 3')
    .toInt(),
];

export const addQuestionValidator = [
  ...kitIdParamValidator,
  body('prompt').isString().trim().isLength({ min: 1 }).withMessage('Prompt is required'),
  body('answer_outline')
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Answer outline is required'),
  body('category')
    .isIn(['technical', 'behavioural', 'system-design', 'company-fit'])
    .withMessage('Category must be a valid question category'),
  body('difficulty')
    .optional()
    .isInt({ min: 1, max: 3 })
    .withMessage('Difficulty must be an integer between 1 and 3')
    .toInt(),
  body('requirement_ids').optional().isArray().withMessage('Requirement IDs must be an array'),
];

export const reorderQuestionsValidator = [
  ...kitIdParamValidator,
  // Empty arrays are legal: an honestly thin kit may hold zero questions, and
  // the service still requires the payload to list every question exactly once.
  body('questionIds').isArray().withMessage('Question IDs must be an array'),
];

export const deleteQuestionValidator = [...kitIdParamValidator, ...questionIdParamValidator];

export const addFlashcardValidator = [
  ...kitIdParamValidator,
  body('front').isString().trim().isLength({ min: 1 }).withMessage('Front is required'),
  body('back').isString().trim().isLength({ min: 1 }).withMessage('Back is required'),
  body('requirement_ids').optional().isArray().withMessage('Requirement IDs must be an array'),
];

export const updateFlashcardValidator = [
  ...kitIdParamValidator,
  ...flashcardIdParamValidator,
  body('front')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Front must not be empty'),
  body('back')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Back must not be empty'),
];

export const deleteFlashcardValidator = [...kitIdParamValidator, ...flashcardIdParamValidator];

export const updateBriefValidator = [
  ...kitIdParamValidator,
  body('summary')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Summary must not be empty'),
  body('what_they_do')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1 })
    .withMessage('What-they-do must not be empty'),
];

export const regenerateValidator = [
  ...kitIdParamValidator,
  body('section')
    .isIn(['company_brief', 'schedule', 'questions'])
    .withMessage('Section must be company_brief, schedule, or questions'),
  body('category')
    .if(body('section').equals('questions'))
    .isIn(['technical', 'behavioural', 'system-design', 'company-fit'])
    .withMessage('Category is required when regenerating questions'),
];
