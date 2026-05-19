import terser from '@rollup/plugin-terser';

export default {
    input: 'libraries/gps.js',
    output: {
        file: 'dist/index.js',
        format: 'iife',
        name: 'GpsNavigationWidget',
    },
    plugins: [terser()],
};
