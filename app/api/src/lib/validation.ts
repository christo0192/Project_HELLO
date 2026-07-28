import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

export interface ValidationErrorDetail {
  field: string;
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    type: 'validation_error' | 'malformed_request' | 'payload_too_large' | 'internal_error';
    message: string;
    details?: ValidationErrorDetail[];
  };
}

function formatZodError(err: ZodError): ValidationErrorDetail[] {
  return err.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

function sendError(
  res: Response,
  status: number,
  type: ApiErrorBody['error']['type'],
  message: string,
  details?: ValidationErrorDetail[],
) {
  const body: ApiErrorBody = { error: { type, message, ...(details ? { details } : {}) } };
  return res.status(status).json(body);
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'Request validation failed',
        formatZodError(result.error),
      );
    }
    req.body = result.data;
    next();
  };
}

export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'Path parameter validation failed',
        formatZodError(result.error),
      );
    }
    req.params = result.data as Record<string, string>;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'Query parameter validation failed',
        formatZodError(result.error),
      );
    }
    req.query = result.data as Record<string, string>;
    next();
  };
}

export function validateBodyFields<T>(schema: ZodSchema<T>) {
  return validateBody(schema);
}

export function requireUploadedFile(req: Request, res: Response, next: NextFunction) {
  if (!req.file) {
    return sendError(res, 400, 'validation_error', 'Request validation failed', [
      { field: 'file', code: 'required', message: 'file is required' },
    ]);
  }
  next();
}

export function malformedJsonHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err instanceof SyntaxError && 'body' in err) {
    return sendError(res, 400, 'malformed_request', 'Request body contains malformed JSON');
  }
  next(err);
}

export function oversizedJsonHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (
    err instanceof Error &&
    'type' in err &&
    (err as { type?: unknown }).type === 'entity.too.large'
  ) {
    return sendError(
      res,
      413,
      'payload_too_large',
      'Request body exceeds the maximum allowed size (2 MB)',
    );
  }
  next(err);
}

export function multerErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof Error && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      return sendError(
        res,
        413,
        'payload_too_large',
        'Uploaded file exceeds the maximum allowed size',
      );
    }
    if (typeof code === 'string' && code.startsWith('LIMIT_')) {
      return sendError(res, 400, 'malformed_request', 'Invalid multipart request');
    }
  }
  next(err);
}

export function zodErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof ZodError) {
    return sendError(
      res,
      400,
      'validation_error',
      'Request validation failed',
      formatZodError(err),
    );
  }
  next(err);
}

export function finalErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error('[unhandled request error]', err instanceof Error ? err.name : typeof err);
  return sendError(res, 500, 'internal_error', 'Internal server error');
}
