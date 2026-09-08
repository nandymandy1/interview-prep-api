export type ApiSuccessResponse<T> = {
  success: true;
  message?: string;
  data?: T;
};

export type ApiResponse<T> = ApiSuccessResponse<T> | {
  success: false;
  message: string;
  details?: unknown;
};
