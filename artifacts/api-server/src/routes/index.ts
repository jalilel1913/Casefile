import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import artifactsRouter from "./artifacts";
import casesRouter from "./cases";
import healthRouter from "./health";
import integrityRouter from "./integrity";
import investigateRouter from "./investigate";
import stepsRouter from "./steps";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use(requireAuth);

router.use(casesRouter);
router.use(artifactsRouter);
router.use(stepsRouter);
router.use(integrityRouter);
router.use(investigateRouter);

export default router;
