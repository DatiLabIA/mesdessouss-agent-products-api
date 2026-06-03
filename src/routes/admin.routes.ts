import { Router, type IRouter } from "express";
import {
  listPolicies,
  getPolicy,
  upsertPolicy,
  patchPolicy,
  deletePolicy,
} from "../handlers/admin-policies";

export const adminRouter: IRouter = Router();

adminRouter.get("/policies", listPolicies);
adminRouter.get("/policies/:topic", getPolicy);
adminRouter.put("/policies/:topic", upsertPolicy);
adminRouter.patch("/policies/:topic", patchPolicy);
adminRouter.delete("/policies/:topic", deletePolicy);
