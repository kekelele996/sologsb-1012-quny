import { Config } from '@stencil/core';

export const config: Config = {
  namespace: 'SignCourseStudio',
  globalScript: 'src/global/app.ts',
  globalStyle: 'src/global/app.css',
  taskQueue: 'async',
  sourceMap: false,
  outputTargets: [
    {
      type: 'www',
      serviceWorker: null,
      dir: 'www',
    },
    {
      type: 'dist',
      esmLoaderPath: '../loader',
    },
    {
      type: 'docs-readme',
    },
  ],
  devServer: {
    port: 3333,
    openBrowser: false,
  },
};
