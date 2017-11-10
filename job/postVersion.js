'use strict';

var self = postVersion;
module.exports = self;

var fs = require('fs-extra');
var getStatusCodeByName = require('../_common/getStatusCodeByName.js');

function postVersion(externalBag, callback) {
  var bag = {
    rawMessage: _.clone(externalBag.rawMessage),
    inPayload: _.clone(externalBag.inPayload),
    outputVersionFilePath: externalBag.outputVersionFilePath,
    consoleAdapter: externalBag.consoleAdapter,
    buildStateDir: externalBag.buildStateDir,
    buildInDir: externalBag.buildInDir,
    buildOutDir: externalBag.buildOutDir,
    stepMessageFilename: externalBag.stepMessageFilename,
    jobStatusCode: externalBag.jobStatusCode,
    isJobCancelled: externalBag.isJobCancelled,
    resourceId: externalBag.resourceId,
    versionSha: externalBag.versionSha,
    projectId: externalBag.projectId,
    trace: externalBag.trace,
    builderApiAdapter: externalBag.builderApiAdapter,
    operation: externalBag.operation
  };
  bag.who = util.format('%s|job|%s', msName, self.name);
  logger.info(bag.who, 'Inside');
  async.series([
      _checkInputParams.bind(null, bag),
      _getOutputVersion.bind(null, bag),
      _extendOutputVersionWithEnvs.bind(null, bag),
      _postTaskVersion.bind(null, bag),
      _postOutResourceVersions.bind(null, bag)
    ],
    function (err) {
      var result;
      if (err) {
        logger.error(bag.who, util.format('Failed to post version'));
      } else{
        logger.info(bag.who, 'Successfully created version');
        result = {
          outputVersion: bag.outputVersion,
          version: bag.version,
          inPayload: bag.inPayload,
          isGrpSuccess: bag.isGrpSuccess,
          jobStatusCode: bag.jobStatusCode
        };
      }
      return callback(err, result);
    }
  );
}

function _checkInputParams(bag, next) {
  var who = bag.who + '|' + _checkInputParams.name;
  logger.verbose(who, 'Inside');

  return next();
}

function _getOutputVersion(bag, next) {
  if (bag.isJobCancelled) return next();
  if (bag.jobStatusCode) return next();

  var who = bag.who + '|' + _getOutputVersion.name;
  logger.verbose(who, 'Inside');
  bag.consoleAdapter.openGrp('Saving resource version');
  bag.consoleAdapter.openCmd('Reading output version');

  fs.readJson(bag.outputVersionFilePath,
    function (err, outputVersion) {
      // don't throw an error if this file doesn't exist
      var msg;
      if (err)
        msg = util.format('Failed to read %s', bag.outputVersionFilePath);
      else
        msg = 'Successfully read output version';

      bag.outputVersion = outputVersion || {};

      bag.consoleAdapter.publishMsg(msg);
      bag.consoleAdapter.closeCmd(true);

      return next();
    }
  );
}

function _extendOutputVersionWithEnvs(bag, next) {
  if (bag.isJobCancelled) return next();
  if (bag.jobStatusCode) return next();

  var who = bag.who + '|' + _extendOutputVersionWithEnvs.name;
  logger.verbose(who, 'Inside');

  bag.consoleAdapter.openCmd('Reading additional job properties');
  var envFilePath = bag.buildStateDir + '/' + bag.inPayload.name + '.env';
  var newVersionName = '';
  var propertyBag = {};
  try {
    var envFile = fs.readFileSync(envFilePath).toString();
    var lines = envFile.split('\n');
    bag.consoleAdapter.publishMsg(
      util.format('found file %s.  Checking for additional properties.',
      envFilePath)
    );
    _.each(lines,
      function (line) {
        var nameAndValue = line.split('=');
        var key = nameAndValue[0];
        var value = nameAndValue[1];
        if (key) {
          bag.consoleAdapter.publishMsg('found a key: ' + key);
          if (key === 'versionName')
            newVersionName = value;
          else
            propertyBag[key] = value;
        }
      }
    );
  } catch (err) {
    bag.consoleAdapter.publishMsg(
      util.format('Could not parse file %s. Hence Skipping.',
        envFilePath));
    bag.consoleAdapter.publishMsg(
      util.format('unable to read file %s.env', bag.inPayload.name));
    bag.consoleAdapter.closeCmd(true);
    bag.consoleAdapter.closeGrp(true);
    return next();
  }
  var extraVersionInfo = {};
  if (newVersionName) {
    bag.consoleAdapter.publishMsg(
      util.format('Found versionName %s', newVersionName));
    extraVersionInfo.versionName = newVersionName;
  }
  if (!_.isEmpty(propertyBag))
    extraVersionInfo.propertyBag = propertyBag;

  _.extend(bag.outputVersion, extraVersionInfo);
  bag.consoleAdapter.closeCmd(true);
  return next();
}

function _postTaskVersion(bag, next) {
  if (bag.isJobCancelled) return next();
  if (!bag.resourceId) return next();

  var who = bag.who + '|' + _postTaskVersion.name;
  logger.verbose(who, 'Inside');

  bag.consoleAdapter.openCmd('Updating resource version');

  // jobStatusCode is only set to failure/error, so if we reach this
  // function without any code we know job has succeeded
  if (!bag.jobStatusCode)
    bag.jobStatusCode = getStatusCodeByName('success');

  var version = {
    resourceId: bag.resourceId,
    projectId: bag.projectId,
    propertyBag: {},
    versionTrigger: false
  };

  bag.isGrpSuccess = true;
  if (bag.outputVersion)
    _.extend(version,  bag.outputVersion);

  version.propertyBag.sha = bag.versionSha;
  version.propertyBag.trace = bag.trace;
  if (!_.isEmpty(bag.rawMessage.jobId))
    version.jobId = bag.rawMessage.jobId;

  var msg;
  bag.builderApiAdapter.postVersion(version,
    function (err, newVersion) {
      if (err) {
        msg = util.format('%s, Failed to post version for ' +
          'resourceId: %s with err: %s', who, bag.resourceId, err);
        bag.consoleAdapter.publishMsg(msg);
        bag.consoleAdapter.closeCmd(false);
        bag.consoleAdapter.closeGrp(false);
        bag.isGrpSuccess = false;
      } else {
        bag.version = newVersion;
        msg = util.format('Successfully posted version:%s for ' +
          'resourceId: %s', newVersion.id, bag.resourceId);
        bag.consoleAdapter.publishMsg(msg);
        bag.consoleAdapter.closeCmd(true);
        bag.consoleAdapter.closeGrp(true);
      }

      return next();
    }
  );
}

function _postOutResourceVersions(bag, next) {
  if (bag.isJobCancelled) return next();
  if (!bag.resourceId) return next();
  if (bag.jobStatusCode !== getStatusCodeByName('success'))
    return next();

  var who = bag.who + '|' + _postOutResourceVersions.name;
  logger.verbose(who, 'Inside');

  async.eachSeries(bag.inPayload.propertyBag.yml.steps,
    function (step, nextStep) {

      var operation = _.find(_.keys(step),
        function (key) {
          return key === bag.operation.OUT;
        }
      );
      if (!operation) return nextStep();

      var name = step[operation];
      logger.verbose('Processing OUT:', name);

      var dependency = _.find(bag.inPayload.dependencies,
        function (dependency) {
          return dependency.name === name && dependency.operation === operation;
        }
      );

      if (!dependency) {
        bag.consoleAdapter.openGrp('Step Error');
        bag.consoleAdapter.openCmd('Errors');

        var msg = util.format('%s, Missing dependency for: %s %s',
          who, operation, name);
        bag.consoleAdapter.publishMsg(msg);
        bag.consoleAdapter.closeCmd(false);
        bag.consoleAdapter.closeGrp(false);

        return nextStep(true);
      }

      var replicate = dependency.versionDependencyPropertyBag &&
        dependency.versionDependencyPropertyBag.replicate;

      // currently ciRepo version comparision and creation is done
      // in its outStep.js file. This is handled separately, as .env file
      // only allows string values and we need json support
      // currently state version comparison and creation is done in
      // its outStep.js file

      if (dependency.type === 'ciRepo' && !replicate) {
        return nextStep();
      }

      var innerBag = {
        who: bag.who,
        consoleAdapter: bag.consoleAdapter,
        jobName: bag.inPayload.name,
        jobType: bag.inPayload.type,
        jobVersionId: bag.version.id,
        jobVersion: bag.version,
        buildOutDir: bag.buildOutDir,
        buildInDir: bag.buildInDir,
        buildStateDir: bag.buildStateDir,
        stepMessageFilename: bag.stepMessageFilename,
        builderApiAdapter: bag.builderApiAdapter,
        dependency: dependency,
        replicate: replicate,
        versionJson: null,
        versionEnv: null,
        versionName: null,
        hasVersion: true,
        hasEnv: true,
        isChanged: false,
        isGrpSuccess: true
      };
      bag.consoleAdapter.openGrp('Processing version for ' + dependency.name);
      async.series([
          __readVersionJson.bind(null, innerBag),
          __readReplicatedVersionJson.bind(null, innerBag),
          __readVersionEnv.bind(null, innerBag),
          __compareVersions.bind(null, innerBag),
          __createTrace.bind(null, innerBag),
          __postVersion.bind(null, innerBag),
          __triggerJob.bind(null, innerBag)
        ],
        function (err) {
          if (innerBag.isGrpSuccess) {
            bag.consoleAdapter.closeGrp(true);
          } else {
            bag.consoleAdapter.closeCmd(false);
            bag.consoleAdapter.closeGrp(false);
          }
          return nextStep(err);
        }
      );
    },
    function (err) {
      if (err)
        bag.jobStatusCode = getStatusCodeByName('failure');
      return next();
    }
  );
}

function __readVersionJson(bag, next) {
  if (bag.dependency.isJob) return next();

  var who = bag.who + '|' + __readVersionJson.name;
  logger.verbose(who, 'Inside');

  var dependencyPath = bag.buildOutDir + '/' + bag.dependency.name;

  bag.consoleAdapter.openCmd('Reading dependency metadata from file');
  bag.consoleAdapter.publishMsg('the path is: ' + dependencyPath + '/');
  var checkFile = dependencyPath + '/' + bag.stepMessageFilename;
  fs.readJson(checkFile,
    function (err, resource) {
      if (err) {
        bag.consoleAdapter.publishMsg(util.format('Failed to read file %s.' +
          ' Hence skipping.', checkFile));
        bag.consoleAdapter.closeCmd(false);
        bag.isGrpSuccess = false;
        bag.hasVersion = false;
        return next();
      }

      bag.versionJson = resource.version || {};
      bag.resourceId = resource.resourceId;
      bag.projectId = resource.projectId;
      if (_.isEmpty(bag.versionJson.propertyBag))
        bag.versionJson.propertyBag = {};

      if (_.has(bag.dependency.versionDependencyPropertyBag, 'overwrite') &&
        bag.dependency.versionDependencyPropertyBag.overwrite === true) {

        var freshPropertyBag = {};

        // params are always stored in a "params" property in the bag
        // This needs to be initialized here so merging the env works later
        if (bag.dependency.type === 'params')
          freshPropertyBag.params = {};

        // shaData is set on OUTs by ciRepo and state
        if (resource.version && resource.version.propertyBag &&
            _.has(resource.version.propertyBag, 'shaData'))
          freshPropertyBag.shaData =
            resource.version.propertyBag.shaData;

        // webhookRequestHeaders is set on OUTs by ciRepo
        if (resource.version && resource.version.propertyBag &&
          _.has(resource.version.propertyBag, 'webhookRequestHeaders'))
          freshPropertyBag.webhookRequestHeaders =
            resource.version.propertyBag.webhookRequestHeaders;

        // webhookRequestBody is set on OUTs by ciRepo
        if (resource.version && resource.version.propertyBag &&
          _.has(resource.version, 'webhookRequestBody'))
          freshPropertyBag.webhookRequestBody =
            resource.version.propertyBag.webhookRequestBody;

        bag.versionJson.propertyBag = freshPropertyBag;
      }

      bag.consoleAdapter.publishMsg(
        'Successfully read dependency metadata file');
      bag.consoleAdapter.closeCmd(true);
      return next();
    }
  );
}

function __readReplicatedVersionJson(bag, next) {
  if (bag.dependency.isJob) return next();
  if (!bag.replicate) return next();

  var who = bag.who + '|' + __readReplicatedVersionJson.name;
  logger.verbose(who, 'Inside');

  var dependencyPath = bag.buildInDir + '/' + bag.replicate;

  bag.consoleAdapter.openCmd('Reading replicated metadata from file');
  bag.consoleAdapter.publishMsg('the path is: ' + dependencyPath + '/');
  var checkFile = dependencyPath + '/' + bag.stepMessageFilename;
  fs.readJson(checkFile,
    function (err, resource) {
      if (err) {
        bag.consoleAdapter.publishMsg(util.format(
          'Failed to find resource %s. Is it an input to this job?',
          bag.replicate));
        bag.consoleAdapter.closeCmd(false);
        bag.isGrpSuccess = false;
        bag.hasVersion = false;
        return next();
      }

      bag.versionJson.versionName = resource.version.versionName;
      bag.versionJson.propertyBag = resource.version.propertyBag || {};

      bag.consoleAdapter.publishMsg(
        'Successfully read replicated metadata file');
      bag.consoleAdapter.closeCmd(true);
      return next();
    }
  );
}

function __readVersionEnv(bag, next) {
  if (bag.dependency.isJob) return next();
  if (!bag.hasVersion) return next();

  var who = bag.who + '|' + __readVersionEnv.name;
  logger.debug(who, 'Inside');

  bag.consoleAdapter.openCmd('Reading resource env file');

  var envFilePath = bag.buildStateDir + '/' + bag.dependency.name + '.env';
  try {
    var envFile = fs.readFileSync(envFilePath).toString();
    var lines = envFile.split('\n');

    _.each(lines,
      function (line) {
        var nameAndValue = line.split('=');
        var key = nameAndValue[0];
        var value = nameAndValue[1];
        if (key) {
          bag.consoleAdapter.publishMsg('found a key: ' + key);
          if (key === 'versionName')
            bag.versionJson.versionName = value;
          else {
            if (bag.dependency.type === 'params') {
              bag.versionJson.propertyBag.params[key] = value;
            } else {
              bag.versionJson.propertyBag[key] = value;
            }
          }
        }
      }
    );
  } catch (err) {
    bag.consoleAdapter.publishMsg(
      util.format('Could not parse file %s. Hence Skipping.',
        envFilePath));
    bag.consoleAdapter.publishMsg(
      util.format('unable to read file %s.env', bag.dependency.name));
    bag.consoleAdapter.closeCmd(false);
    bag.hasEnv = false;
  }
  bag.consoleAdapter.publishMsg('Successfully parsed .env file.');
  bag.consoleAdapter.closeCmd(true);

  return next();
}

function __compareVersions(bag, next) {
  if (bag.dependency.isJob) return next();
  if (!bag.hasVersion) return next();

  var who = bag.who + '|' + __compareVersions.name;
  logger.debug(who, 'Inside');

  bag.consoleAdapter.openCmd('comparing current version to original');
  var originalVersion = bag.dependency.version;

  // Don't compare the trace
  if (originalVersion.propertyBag) {
    if (originalVersion.propertyBag.trace)
      delete originalVersion.propertyBag.trace;
    if (originalVersion.propertyBag.sourceObjectId)
      delete originalVersion.propertyBag.sourceObjectId;
    if (originalVersion.propertyBag.sourceObjectType)
      delete originalVersion.propertyBag.sourceObjectType;
  }

  if (bag.versionJson.propertyBag) {
    if (bag.versionJson.propertyBag.trace)
      delete bag.versionJson.propertyBag.trace;
    if (bag.versionJson.propertyBag.sourceObjectId)
      delete bag.versionJson.propertyBag.sourceObjectId;
    if (bag.versionJson.propertyBag.sourceObjectType)
      delete bag.versionJson.propertyBag.sourceObjectType;
  }

  if (originalVersion.versionName !== bag.versionJson.versionName) {
    bag.isChanged = true;
    bag.consoleAdapter.publishMsg('versionName has changed');

  } else if (!_.isEqual(originalVersion.propertyBag,
    bag.versionJson.propertyBag)) {

    bag.isChanged = true;
    bag.consoleAdapter.publishMsg('propertyBag has changed');
  }

  if (!bag.isChanged)
    bag.consoleAdapter.publishMsg('version has NOT changed');
  bag.consoleAdapter.closeCmd(true);
  return next();
}

function __createTrace(bag, next) {
  if (bag.dependency.isJob) return next();
  if (!bag.isChanged) return next();

  var who = bag.who + '|' + __createTrace.name;
  logger.verbose(who, 'Inside');

  bag.versionJson.propertyBag.trace = [];

  var resourceType = _.findWhere(global.systemCodes,
    {name: bag.jobType, group: 'resource'});

  var traceObject = {
    operation: 'IN',
    resourceId: bag.jobVersion.resourceId,
    resourceName: bag.jobName,
    resourceTypeCode: (resourceType && resourceType.code) || null,
    versionId: bag.jobVersionId,
    versionNumber: bag.jobVersion.versionNumber,
    versionName: bag.jobVersion.versionName,
    versionCreatedAt: bag.jobVersion.createdAt,
    usedByVersionId: 0 // Save 0 for the current version
  };

  bag.versionJson.propertyBag.trace.push(traceObject);

  if (!bag.jobVersion.propertyBag) return;

  _.each(bag.jobVersion.propertyBag.trace,
    function (dependencyTraceObject) {
      if (dependencyTraceObject.operation !== 'IN')
        return;
      if (dependencyTraceObject.usedByVersionId === 0)
        dependencyTraceObject.usedByVersionId = bag.jobVersionId;
      bag.versionJson.propertyBag.trace.push(dependencyTraceObject);
    }
  );

  return next();
}

function __postVersion(bag, next) {
  if (bag.dependency.isJob) return next();
  if (!bag.isChanged) return next();

  var who = bag.who + '|' + __postVersion.name;
  logger.verbose(who, 'Inside');

  bag.consoleAdapter.openCmd('Posting new version');
  var newVersion = {
    resourceId: bag.resourceId,
    propertyBag: bag.versionJson.propertyBag,
    versionName: bag.versionJson.versionName,
    projectId: bag.projectId
  };

  bag.builderApiAdapter.postVersion(newVersion,
    function (err, version) {
      var msg;
      if (err) {
        msg = util.format('%s, Failed to post version for resourceId: %s',
          who, bag.versionJson.resourceId, err);
        bag.consoleAdapter.publishMsg(msg);
        bag.consoleAdapter.closeCmd(false);
        bag.isGrpSuccess = false;
        return next(true);
      }

      bag.versionJson = version;
      msg = util.format('Post version for resourceId: %s succeeded with ' +
        'version %s', bag.versionJson.resourceId,
        util.inspect(bag.versionJson.versionNumber)
      );
      bag.consoleAdapter.publishMsg(msg);
      bag.consoleAdapter.closeCmd(true);
      return next();
    }
  );
}

function __triggerJob(bag, next) {
  if (!bag.dependency.isJob) return next();

  var who = bag.who + '|' + __triggerJob.name;
  logger.verbose(who, 'Inside');

  bag.consoleAdapter.openCmd('Triggering job: ' + bag.dependency.name);
  bag.builderApiAdapter.triggerNewBuildByResourceId(
    bag.dependency.resourceId, {},
    function (err) {
      if (err) {
        bag.consoleAdapter.publishMsg(util.format(
          'failed to trigger job: %s', err));
        bag.consoleAdapter.closeCmd(false);
        return next(true);
      }
      bag.consoleAdapter.publishMsg('Successfully triggered job.');
      bag.consoleAdapter.closeCmd(true);
      return next();
    }
  );
}
