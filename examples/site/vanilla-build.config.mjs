// Build config for the example site. Run from this folder:
//   node ../../bin/vanilla-build.mjs
export default {
  root: 'src',          // pages, scripts, styles and images live here
  outDir: 'dist',       // emptied and rebuilt on every run
  publicDir: 'public',  // copied as is over the output (robots.txt, favicon, ...)
  integrity: true,      // add integrity="sha384-..." to <script> and stylesheet <link>
};
