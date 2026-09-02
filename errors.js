export class AppError extends Error {
    constructor(message, statusCode = 400, code = 'APP_ERROR', options = {}) {
        super(message, options);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

export class SupersededError extends Error {
    constructor() {
        super('تم استبدال العملية بطلب أحدث.');
        this.name = 'SupersededError';
    }
}

export function publicError(error) {
    if (error instanceof AppError) {
        return error;
    }

    if (error?.name === 'AbortError' || error instanceof SupersededError) {
        return new AppError('تم إلغاء العملية.', 409, 'ABORTED');
    }

    return new AppError(
        'تعذر تنفيذ الطلب. راجع سجل الخدمة لمعرفة التفاصيل.',
        500,
        'INTERNAL_ERROR',
    );
}
