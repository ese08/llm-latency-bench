'use strict';

const siliconflow = require('./siliconflow');
const ark = require('./ark');
const openrouter = require('./openrouter');

const PROVIDERS = {
  siliconflow,
  ark,
  openrouter,
};

function getProvider(platform) {
  const provider = PROVIDERS[platform];
  if (!provider) throw new Error(`未知平台：${platform}`);
  return provider;
}

module.exports = { getProvider, PROVIDERS };
