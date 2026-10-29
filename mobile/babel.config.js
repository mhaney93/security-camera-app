module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Compiles 'worklet' functions so VisionCamera frame processors can run them
    plugins: [['react-native-worklets-core/plugin']],
  };
};
