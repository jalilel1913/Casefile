import cors from "cors";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/error-handler";
import router from "./routes";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// 96mb headroom — fits a 64MB binary base64-encoded (~85MB) plus JSON
// envelope. Handlers enforce tighter per-kind limits on artifact content
// (10 MB text / 64 MB decoded binary).
app.use(express.json({ limit: "96mb" }));
app.use(express.urlencoded({ extended: true, limit: "96mb" }));

app.use("/api", router);

app.use(errorHandler);

export default app;
