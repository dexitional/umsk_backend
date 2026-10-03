"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRequestContext = exports.requestContext = void 0;
const async_hooks_1 = require("async_hooks");
exports.requestContext = new async_hooks_1.AsyncLocalStorage();
const getRequestContext = () => exports.requestContext.getStore();
exports.getRequestContext = getRequestContext;
