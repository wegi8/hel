/** @typedef {import('../index').IPlatformConfig} IPlatformConfig */
/** @typedef {import('../index').IPlatformConfigFull} IPlatformConfigFull */
/** @typedef {import('../index').SharedCache} SharedCache */
import * as consts from './consts';
import * as diff from './diff/index';
import * as helper from './helper';
import * as isSubMod from './isSubApp';
import * as debugMod from './microDebug';
import { ensureHelMicroShared, getHelMicroShared } from './microShared';
import * as util from './util';
import * as utilBase from './utilBase';

util.log(`hel-micro-core ver ${consts.VER}`);

// 载入此包就尝试设置 masterApp 锁，以推断自己是不是父应用
isSubMod.trySetMasterAppLoadedSignal();
// 确保 __HEL_MICRO_SHARED__ 存在
ensureHelMicroShared();

const inner = {
  setVerLoadStatus(appName, loadStatus, statusMapKey, options) {
    const { versionId, platform } = options || {};
    const appVerLoadStatus = getSharedCache(platform)[statusMapKey];
    const versionIdVar = versionId || DEFAULT_ONLINE_VER;
    util.setSubMapValue(appVerLoadStatus, appName, versionIdVar, loadStatus);
  },

  getVerLoadStatus(appName, statusMapKey, options) {
    const { versionId, platform } = options || {};
    const appVerLoadStatus = getSharedCache(platform)[statusMapKey];
    const versionIdVar = versionId || DEFAULT_ONLINE_VER;
    return appVerLoadStatus[appName]?.[versionIdVar] || consts.HEL_LOAD_STATUS.NOT_LOAD;
  },

  // 预防一些未升级的老模块未写 DEFAULT_ONLINE_VER 的值到 libOrAppMap 里
  ensureOnlineModule(libOrAppMap, appName, platform) {
    if (libOrAppMap[DEFAULT_ONLINE_VER]) {
      return;
    }
    const appMeta = getAppMeta(appName, platform);
    const onlineModule = libOrAppMap[appMeta?.online_version];
    if (onlineModule) {
      libOrAppMap[DEFAULT_ONLINE_VER] = onlineModule;
    }
  },
};

export const isSubApp = isSubMod.isSubApp;

// 暴露出去，仅仅为兼容以前的调用此函数代码不报错，但是说明上已标即不鼓励使用
export const trySetMasterAppLoadedSignal = isSubMod.trySetMasterAppLoadedSignal;

/**
 * 获取默认的平台值
 * @returns
 */
export const getPlatform = helper.getPlatform;

export const helEvents = consts.HEL_EVENTS;

export const helLoadStatus = consts.HEL_LOAD_STATUS;

export const DEFAULT_ONLINE_VER = consts.DEFAULT_ONLINE_VER;

export const log = util.log;

export const allowLog = util.allowLog;

export const getHelDebug = debugMod.getHelMicroDebug;

export const getGlobalThis = utilBase.getGlobalThis;

export const setGlobalThis = utilBase.setGlobalThis;

export function getHelEventBus() {
  return getHelMicroShared().eventBus;
}

/**
 * @param {string} platform
 */
export function getSharedCache(platform) {
  return helper.getPlatformSharedCache(platform);
}

export function tryGetVersion(appGroupName, platform) {
  // 形如: at c (https://{cdn_host_name}/{platform}/{appname_prefixed_version}/static/js/4.b60c0895.chunk.js:2:44037
  // 用户串改过的话，可能是：at c (https://{user_cdn}/{user_dir1}/{user_dir2 ...}/{platform}/{appname_prefixed_version}/...)
  const loc = util.getJsRunLocation();
  util.log(`[[tryGetVersion]] may include source > ${loc}`);

  const { appGroupName2firstVer } = getSharedCache(platform);
  const callerSpecifiedVer = appGroupName2firstVer[appGroupName] || '';

  if (loc.includes('https://') || loc.includes('http://')) {
    const [, restStr] = loc.split('//');
    const strList = restStr.split('/');

    // 优先判断可能包含的版本特征
    if (callerSpecifiedVer) {
      if (platform === consts.PLAT_UNPKG && strList.some((item) => item.includes(callerSpecifiedVer))) {
        return callerSpecifiedVer;
      }
      if (strList.includes(callerSpecifiedVer)) {
        return callerSpecifiedVer;
      }
    }

    // [ 'unpkg.com' , 'hel-lodash@1.1.0' , ... ]
    if (platform === consts.PLAT_UNPKG) {
      return strList[1].split('@')[1] || callerSpecifiedVer;
    }

    // 走默认的规则： {cdn_host_name}/{platform}/{appname_prefixed_version}，取下标2对应元素作为版本号
    return strList[2] || callerSpecifiedVer;
  }

  // 在微容器里运行时，js全是在VM里初始化的，此时拿不到具体的加载链接了
  return callerSpecifiedVer;
}

export function tryGetAppName(/** @type string */ version, appGroupName) {
  // 来自 hel 管理台的版本号规则
  if (version.includes('_')) {
    // lib-test_20220621165953 ---> lib-test
    const appName = version.substring(0, version.length - 15);
    return appName;
  }

  // 来自 unpkg
  return appGroupName || '';
}

export function libReady(appGroupName, appProperties, options = {}) {
  const platform = options.platform || getAppPlatform(appGroupName);
  let versionId = tryGetVersion(appGroupName, platform);
  let appName = tryGetAppName(versionId, appGroupName);

  const appMeta = getAppMeta(appName, platform);
  // @ts-ignore，来自于用户设定 cust 配置弹射的模块
  if (appMeta && appMeta.__fromCust) {
    versionId = appMeta.online_version;
    appName = appMeta.name;
  }

  const emitApp = {
    platform,
    appName,
    appGroupName,
    versionId,
    appProperties,
    Comp: function EmptyComp() {},
    lifecycle: {},
  };
  setEmitLib(appName, emitApp, { appGroupName, platform });

  const eventBus = getHelEventBus();
  eventBus.emit(helEvents.SUB_LIB_LOADED, emitApp);
}

export function getPlatformHost(iPlatform) {
  const platform = iPlatform || getPlatform();
  const { apiPrefix } = getSharedCache(platform);

  if (apiPrefix) {
    return apiPrefix;
  }

  return diff.getDefaultApiPrefix(platform);
}

/**
 * 提取无其他杂项的配置对象
 * @param {SharedCache} mayCache
 * @returns {IPlatformConfigFull}
 */
function getPureConfig(mayCache) {
  const {
    apiMode,
    apiPrefix,
    apiSuffix,
    apiPathOfApp,
    apiPathOfAppVersion,
    getSubAppAndItsVersionFn,
    onFetchMetaFailed,
    strictMatchVer,
    getUserName,
    userLsKey,
    platform,
  } = mayCache;
  return {
    apiMode,
    apiPrefix,
    apiSuffix,
    apiPathOfApp,
    apiPathOfAppVersion,
    getSubAppAndItsVersionFn,
    onFetchMetaFailed,
    strictMatchVer,
    getUserName,
    userLsKey,
    platform,
  };
}

/**
 *
 * @param {IPlatformConfig} config
 * @param {string} [iPlatform ]
 * @returns
 */
export function initPlatformConfig(/** @type {import('../index').IPlatformConfig} */ config, iPlatform) {
  const cache = helper.getPlatformSharedCache(iPlatform);
  const pureConfig = getPureConfig(config);
  if (cache.isConfigOverwrite) {
    // 对应平台的 initPlatformConfig 只接受一次调用
    return;
  }
  cache.isConfigOverwrite = true;
  util.safeAssign(cache, pureConfig);
}

export function getPlatformConfig(iPlatform) {
  const cache = helper.getPlatformSharedCache(iPlatform);
  return getPureConfig(cache);
}

export function setEmitApp(appName, /** @type {import('hel-types').IEmitAppInfo} */ emitApp) {
  const { versionId, platform } = emitApp;
  const sharedCache = getSharedCache(platform);
  const { appName2verEmitApp, appName2Comp, appName2EmitApp, appName2app } = sharedCache;

  if (helper.isVerMatchOnline(appName2app[appName], versionId)) {
    appName2Comp[appName] = emitApp.Comp;
    appName2EmitApp[appName] = emitApp;
    util.setSubMapValue(appName2verEmitApp, appName, DEFAULT_ONLINE_VER, emitApp);
  }

  if (versionId) {
    util.setSubMapValue(appName2verEmitApp, appName, versionId, emitApp);
  }
}

export function getVerApp(appName, options) {
  const { versionId, platform } = options || {};
  const { appName2verEmitApp, appName2Comp, strictMatchVer, appName2EmitApp } = getSharedCache(platform);
  const targetStrictMatchVer = options.strictMatchVer ?? strictMatchVer;
  const verEmitAppMap = util.safeGetMap(appName2verEmitApp, appName);
  inner.ensureOnlineModule(verEmitAppMap, appName, platform);

  // 不传递具体版本号就执行默认在线版本
  const versionIdVar = versionId || DEFAULT_ONLINE_VER;
  const verApp = verEmitAppMap[versionIdVar];

  const Comp = appName2Comp[appName];
  // { Comp } 是为了兼容老包写入的数据，老包未写入 appName2EmitApp
  const legacyWriteVerApp = Comp ? { Comp } : null;
  // 指定了版本严格匹配的话，兜底模块置为空
  const fallbackApp = targetStrictMatchVer ? null : appName2EmitApp[appName] || legacyWriteVerApp;
  const result = verApp || fallbackApp || null;
  log(`[[ getVerApp ]] appName,options,result`, appName, options, result);
  return result;
}

export function getAppMeta(appName, platform) {
  const appName2app = getSharedCache(platform).appName2app;
  return appName2app[appName];
}

export function setAppMeta(/** @type {import('hel-types').ISubApp}*/ appMeta, platform) {
  const { appName2app } = getSharedCache(platform);
  appName2app[appMeta.name] = appMeta;
}

export function setEmitLib(appName, /** @type {import('hel-types').IEmitAppInfo} */ emitApp, options) {
  const { appGroupName } = options || {};
  const { versionId, appProperties } = emitApp;
  const platform = emitApp.platform || options.platform;
  const sharedCache = getSharedCache(platform);
  const { appName2verEmitLib, appName2Lib, appName2isLibAssigned } = sharedCache;
  const appMeta = getAppMeta(appName, platform);

  const assignLibObj = (appName) => {
    // 区别于 setEmitApp，使用文件头静态导入模块语法时，默认是从 appName2Lib 拿数据
    // !!! 不再经过 isVerMatchOnline 逻辑成立后才记录 appName2Lib
    // 这意味着 文件头静态导入 总是执行第一个加载的版本模块，
    // （ 注：文件头静态导入对接的是 hel-lib-proxy 的 exposeLib，该接口使用的是 appName2Lib ）
    // 所以 多版本同时导入 和 文件头静态导入 本身是冲突的，用户不应该两种用法一起使用，
    // 否则 文件头静态导入 的模块是不稳定的，除非用户知道后果并刻意这样做
    // marked at 2022-05-06
    const libObj = appName2Lib[appName];
    // 未静态导入时，libObj 是 undefined
    if (!libObj) {
      appName2Lib[appName] = appProperties;
    } else if (typeof libObj === 'object' && Object.keys(libObj).length === 0) {
      // 静态导入时，emptyChunk 那里调用 exposeLib 会提前生成一个 {} 对象
      // 这里只需负责 merge 模块提供方通过 libReady 提供的模块对象
      Object.assign(libObj, appProperties);
    }
    appName2isLibAssigned[appName] = true;
  };
  assignLibObj(appName);
  // 确保 preFetchLib 传入测试应用名时，exposeLib 获取的代理对象能够指到测试库
  // 这样静态导入才能正常工作
  if (appGroupName) {
    assignLibObj(appGroupName);
  } else {
    appMeta && assignLibObj(appMeta.app_group_name);
  }

  // 当前版本可作为默认线上版本来记录
  log(`[[ setEmitLib ]] appMeta`, appMeta);
  const verEmitLibMap = util.safeGetMap(appName2verEmitLib, appName);
  if (
    (!appMeta && !verEmitLibMap[DEFAULT_ONLINE_VER]) // 使用 custom 配置直接载入目标模块时
    || helper.isVerMatchOnline(appMeta, versionId)
  ) {
    util.setSubMapValue(appName2verEmitLib, appName, DEFAULT_ONLINE_VER, appProperties);
  }

  if (versionId) {
    util.setSubMapValue(appName2verEmitLib, appName, versionId, appProperties);
  }
}

export function getVerLib(appName, inputOptions) {
  const options = inputOptions || {};
  const { versionId, platform } = options;
  const sharedCache = getSharedCache(platform);
  const { appName2verEmitLib, appName2Lib, strictMatchVer, appName2isLibAssigned } = sharedCache;
  const targetStrictMatchVer = options.strictMatchVer ?? strictMatchVer;
  const verEmitLibMap = util.safeGetMap(appName2verEmitLib, appName);
  inner.ensureOnlineModule(verEmitLibMap, appName);

  // 不传递具体版本号就执行默认在线版本
  const versionIdVar = versionId || DEFAULT_ONLINE_VER;
  const verLib = verEmitLibMap[versionIdVar];

  // 未分配的模块，直接返回 null 即可，因为 appName2Lib 里会被 exposeLib 提前注入一个 {} 对象占位
  const staticLib = appName2isLibAssigned[appName] ? appName2Lib[appName] : null;
  // 指定了版本严格匹配的话，兜底模块置为空
  const fallbackLib = targetStrictMatchVer ? null : staticLib;
  const result = verLib || fallbackLib || null;
  log(`[[ getVerLib ]] appName,options,result`, appName, options, result);
  return result;
}

export function setVerExtraCssList(appName, cssList, inputOptions) {
  const options = inputOptions || {};
  const { versionId, platform } = options;
  const sharedCache = getSharedCache(platform);
  const { appName2verExtraCssList } = sharedCache;
  const appMeta = getAppMeta(appName, platform);

  log(`[[ setVerExtraCssList ]] cssList`, cssList);
  const verExtraCssListMap = util.safeGetMap(appName2verExtraCssList, appName);
  if (
    (!appMeta && !verExtraCssListMap[DEFAULT_ONLINE_VER]) // 使用 custom 配置直接载入目标模块时
    || helper.isVerMatchOnline(appMeta, versionId)
  ) {
    util.setSubMapValue(appName2verExtraCssList, appName, DEFAULT_ONLINE_VER, cssList);
  }

  if (versionId) {
    util.setSubMapValue(appName2verExtraCssList, appName, versionId, cssList);
  }
}

export function getVerExtraCssList(appName, inputOptions) {
  const options = inputOptions || {};
  const { versionId, platform } = options;
  const sharedCache = getSharedCache(platform);
  const { appName2verExtraCssList } = sharedCache;
  const verExtraCssListMap = util.safeGetMap(appName2verExtraCssList, appName);
  const cssList = verExtraCssListMap[versionId] || verExtraCssListMap[DEFAULT_ONLINE_VER] || [];
  log(`[[ getVerExtraCssList ]] options, cssList`, options, cssList);
  return cssList;
}

export function setVerLoadStatus(appName, loadStatus, options) {
  inner.setVerLoadStatus(appName, loadStatus, 'appName2verLoadStatus', options);
}

export function getVerLoadStatus(appName, options) {
  return inner.getVerLoadStatus(appName, 'appName2verLoadStatus', options);
}

export function setVerStyleStrStatus(appName, loadStatus, options) {
  inner.setVerLoadStatus(appName, loadStatus, 'appName2verStyleFetched', options);
}

export function getVerStyleStrStatus(appName, options) {
  return inner.getVerLoadStatus(appName, 'appName2verStyleFetched', options);
}

/**
 * hel-micro innerPreFetch 会调用此接口提前记录一下应用名对应的版本号
 */
export function setAppPlatform(appGroupName, platform) {
  helper.getCacheRoot().appGroupName2platform[appGroupName] = platform;
  return getAppPlatform(appGroupName);
}

/**
 * 优先获取用户为某个应用单独设定的平台值，目前设定的时机有 preFetch、preFetchLib 时指定的平台值
 * 这里是为了在 exposeLib 接口未指定平台值时可以动态的推导出目标模块的平台值
 * @returns
 */
export function getAppPlatform(appGroupName) {
  return helper.getCacheRoot().appGroupName2platform[appGroupName] || helper.getPlatform();
}

export function getVersion(appName, options) {
  const { platform, versionId } = options || {};
  const { appName2verAppVersion, appName2appVersion } = getSharedCache(platform);

  // TODO: 暂未考虑接入 strictMatchVer
  const fallbackVerData = appName2appVersion[appName] || null;
  if (!versionId) {
    return fallbackVerData;
  }
  return appName2verAppVersion[appName]?.[versionId] || fallbackVerData;
}

export function setVersion(appName, /** @type {import('hel-types').ISubAppVersion}*/ versionData, options) {
  const { platform } = options || {};
  const { appName2verAppVersion, appName2appVersion, appName2app, appGroupName2firstVer } = getSharedCache(platform);
  const versionId = versionData.sub_app_version;
  const appMeta = getAppMeta(appName, platform);

  if (helper.isVerMatchOnline(appName2app[appName], versionId)) {
    appName2appVersion[appName] = versionData;
    util.setSubMapValue(appName2verAppVersion, appName, DEFAULT_ONLINE_VER, versionData);
  }
  util.setSubMapValue(appName2verAppVersion, appName, versionId, versionData);

  appGroupName2firstVer[appMeta.app_group_name] = versionId;
}

export function getAppStyleStr(appName, options) {
  const { platform, versionId } = options || {};
  const { appName2verStyleStr, appName2styleStr } = getSharedCache(platform);

  // TODO: 暂未考虑接入 strictMatchVer
  const fallbackStyleStr = appName2styleStr[appName] || '';
  // 兼容老包未写 versionId 的情况
  if (!versionId) {
    return fallbackStyleStr;
  }

  return appName2verStyleStr[appName]?.[versionId] || fallbackStyleStr || '';
}

export function setAppStyleStr(appName, str, options) {
  const { platform, versionId } = options || {};
  const { appName2verStyleStr, appName2verStyleFetched, appName2styleStr } = getSharedCache(platform);
  // 兼容老包未写 versionId 的情况
  if (!versionId) {
    appName2styleStr[appName] = str;
    return;
  }

  util.setSubMapValue(appName2verStyleStr, appName, versionId, str);
  util.setSubMapValue(appName2verStyleFetched, appName, versionId, helLoadStatus.LOADED);
}

export default {
  DEFAULT_ONLINE_VER,
  helLoadStatus,
  helEvents,
  isSubApp,
  trySetMasterAppLoadedSignal,
  getHelEventBus,
  getHelDebug,
  getSharedCache,
  getPlatform,
  getPlatformHost,
  getPlatformConfig,
  getAppPlatform,
  setAppPlatform,
  // 应用Comp get set
  getVerApp,
  setEmitApp,
  // 应用lib get set
  getVerLib,
  setEmitLib,
  // 应用元数据 get set
  getAppMeta,
  setAppMeta,
  // 版本元数据 get set
  getVersion,
  setVersion,
  // 构建生成样式字符串 get set
  getAppStyleStr,
  setAppStyleStr,
  // 版本获取状态 get set
  getVerLoadStatus,
  setVerLoadStatus,
  // 样式字符串获取状态 get set
  getVerStyleStrStatus,
  setVerStyleStrStatus,
  // sdk注入的额外样式列表
  getVerExtraCssList,
  setVerExtraCssList,
  tryGetVersion,
  tryGetAppName,
  initPlatformConfig,
  libReady,
  log,
  allowLog,
  getGlobalThis,
  setGlobalThis,
};
