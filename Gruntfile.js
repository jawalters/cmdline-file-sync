// Gruntfile.js

'use strict';

module.exports = function(grunt) {
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    jshint: {
      file: ['Gruntfile.js', 'app.js', 'test/*.js'],
      options: {
        jshintrc: true
      }
    },
    mochaTest: {
      test: {
        options: {
          reporter: 'spec'
        },
        src: ['test/*.js']
      }
    }
  });

  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-mocha-test');

  grunt.registerTask('test', ['jshint', 'mochaTest']);

  grunt.registerTask('default', ['jshint']);
};
