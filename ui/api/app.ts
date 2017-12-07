import * as aws from 'aws-sdk';
import * as express from 'express';
import * as Api from 'kubernetes-client';
import * as bodyParser from 'body-parser';
import * as fallback from 'express-history-api-fallback';
import * as models from '../src/app/models';
import { Observable } from 'rxjs/Observable';
import { Observer } from 'rxjs/Observer';
import * as nodeStream from 'stream';
import * as path from 'path';
import * as moment from 'moment';

function reactifyStream(stream, converter = item => item) {
  return new Observable((observer: Observer<any>) => {
      stream.on('data', (d) => observer.next(converter(d)));
      stream.on('end', () => observer.complete());
      stream.on('error', e => observer.error(e));
  });
}

function reactifyStringStream(stream) {
  return reactifyStream(stream, item => item.toString());
}

function streamServerEvents<T>(req: express.Request, res: express.Response, source: Observable<T>, formatter: (input: T) => string) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const subscription = source.subscribe(
      (info) => res.write(`data:${formatter(info)}\n\n`),
      (err) => res.end(),
      () => res.end());
  req.on('close', () => subscription.unsubscribe());
}

function serve<T>(res: express.Response, action: () => Promise<T>) {
  action().then(val => res.send(val)).catch(err => res.status(500).send(err));
}

function decodeBase64(input: string) {
  return new Buffer(input, 'base64').toString('ascii');
}

export function create(
    uiDist: string,
    inCluster: boolean,
    namespace: string,
    version,
    group = 'argoproj.io') {
  const config = Object.assign(
    {}, inCluster ? Api.config.getInCluster() : Api.config.fromKubeconfig(), {namespace, promises: true });
  const core = new Api.Core(config);
  const crd = new Api.CustomResourceDefinitions(Object.assign(config, {version, group}));
  crd.addResource('workflows');
  const app = express();
  app.use(bodyParser.json({type: () => true}));

  app.get('/api/workflows', (req, res) => serve(res, async () => {
    let statuses: string[] = [];
    if (req.query.status) {
      statuses = req.query.status instanceof Array ? req.query.status : [req.query.status];
    }
    const workflowList = <models.WorkflowList> await crd['workflows'].get({
      qs: {labelSelector: statuses.length > 0 && `workflows.argoproj.io/phase in (${statuses.join(',')})` || ''}
    });
    workflowList.items.sort(
      (first, second) => moment(first.metadata.creationTimestamp) < moment(second.metadata.creationTimestamp) ? 1 : -1);
    return workflowList;
  }));

  app.get('/api/workflows/:namespace/:name',
    async (req, res) => serve(res, () => crd.ns(req.params.namespace)['workflows'].get(req.params.name)));

  app.get('/api/workflows/:namespace/:name/artifacts/:nodeName/:artifactName', async (req, res) => {
    const workflow: models.Workflow = await crd.ns(req.params.namespace)['workflows'].get(req.params.name);
    const node = workflow.status.nodes[req.params.nodeName];
    const artifact = node.outputs.artifacts.find(item => item.name === req.params.artifactName);
    if (artifact.s3) {
      const secretAccessKey = decodeBase64((await core.ns(
        workflow.metadata.namespace).secret.get(artifact.s3.secretKeySecret.name)).data[artifact.s3.secretKeySecret.key]);
      const accessKeyId = decodeBase64((await core.ns(
        workflow.metadata.namespace).secret.get(artifact.s3.accessKeySecret.name)).data[artifact.s3.accessKeySecret.key]);
      const s3 = new aws.S3({
        secretAccessKey, accessKeyId, endpoint: `http://${artifact.s3.endpoint}`, s3ForcePathStyle: true, signatureVersion: 'v4' });
      s3.getObject({ Bucket: artifact.s3.bucket, Key: artifact.s3.key }, (err, data) => {
        if (err) {
          console.error(err);
          res.send({ code: 'INTERNAL_ERROR', message: `Unable to download artifact` });
        } else {
          const readStream = new nodeStream.PassThrough();
          readStream.end(data.Body);
          res.set('Content-disposition', 'attachment; filename=' + path.basename(artifact.s3.key));
          readStream.pipe(res);
        }
      });
    }
  });
  app.get('/api/steps/:namespace/:name/logs', (req, res) => {
    const logsSource = reactifyStringStream(
      core.ns(req.params.namespace).po(req.params.name).log.getStream({ qs: { container: 'main', follow: true } }));
    streamServerEvents(req, res, logsSource, item => item.toString());
  });
  app.use(express.static(uiDist));
  app.use(fallback('index.html', { root: uiDist }));
  return app;
}