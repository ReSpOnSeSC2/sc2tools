import "express";

declare module "express-serve-static-core" {
  interface Request {
    clientId?: string;
    rawBody?: Buffer;
    id?: string;
  }
}

export {};
