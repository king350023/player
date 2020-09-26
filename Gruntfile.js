/* jshint node: true */

var path = require('path');
var webpack = require('webpack');
var parallelWebpack = require('parallel-webpack');
var env = process.env;

function getBuildVersion(packageInfo) {
    // Build Version: {major.minor.revision}
    var metadata = '';
    if (env.BUILD_NUMBER) {
        var branch = env.GIT_BRANCH;
        metadata = 'opensource';
        if (branch) {
            metadata += '_' + branch.replace(/^origin\//, '').replace(/[^0-9A-Za-z-]/g, '-');
        }
        metadata += '.' + env.BUILD_NUMBER;
    } else {
        var now = new Date();
        now.setTime(now.getTime()-now.getTimezoneOffset()*60000);
        metadata = 'local.' + now.toISOString().replace(/[\.\-:T]/g, '-').replace(/Z|\.\d/g, '');
    }
    return packageInfo.version +'+'+ metadata;
}

module.exports = function(grunt) {

    require('load-grunt-tasks')(grunt);

    var packageInfo = grunt.file.readJSON('package.json');
    var buildVersion = getBuildVersion(packageInfo);
    // both flashVersion and swfTarget are needed to force flex to build using the right version
    var flashVersion = 11.2;

    // For task testing
    // grunt.loadTasks('../grunt-flash-compiler/tasks');

    console.log('%s v%s', packageInfo.name, buildVersion);

    grunt.initConfig({
        starttime: new Date(),
        pkg: packageInfo,

        jshint: {
            options: {
                jshintrc: '.jshintrc'
            },
            player : [
                'src/js/**/*.js'
            ],
            tests : [
                'test/{,*/}*.js'
            ],
            grunt : [
                'Gruntfile.js'
            ]
        },

        // lints Less
        recess: {
            options: {
                // Set compile and compress to false to lint
                compile: false,
                compress: false,
                noIDs: true,
                noJSPrefix: true,
                noOverqualifying: false,
                noUnderscores: true,
                noUniversalSelectors: false,// true,
                strictPropertyOrder: false, // true,
                zeroUnits: false,
                includePaths: ['src/css', 'src/css/*']
            },
            lint: {
                files: [{
                    expand: true,
                    ext: '.css',
                    dest: 'bin-debug/skins/',
                    cwd: 'src/css/',
                    src: '{,*/}*.less'
                }]
            },
            internal: {
                options: {
                    compile: true
                },
                files: {
                    'bin-debug/reference/jwplayer.css': 'src/css/jwplayer.less'
                }
            },
            debug: {
                options: {
                    compile: true
                },
                files: [{
                    expand: true,
                    ext: '.css',
                    dest: 'bin-debug/skins/',
                    cwd: 'src/css/skins/',
                    src: '*.less'
                }]
            },
            release: {
                options: {
                    compile: true,
                    compress: true
                },
                files: [{
                    expand: true,
                    ext: '.css',
                    dest: 'bin-release/skins/',
                    cwd: 'src/css/skins/',
                    src: '*.less'
                }]
            }
        },

        watch : {
            options: {
                livereload: true
            },
            jshint: {
                files: [
                    '.jshintrc',
                    '.jshintignore'
                ],
                tasks: ['jshint']
            },
            player: {
                files : ['src/js/**/*.js'],
                tasks: ['webpack:debug', 'jshint:player', 'karma:local'],
                options: {
                    spawn: false
                }
            },
            css: {
                files: ['src/css/{,*/}*.less'],
                tasks: ['webpack:debug', 'recess:lint', 'recess:debug'],
                options: {
                    spawn: false
                }
            },
            tests: {
                files : ['test/{,*/}*.js'],
                tasks: ['jshint:tests', 'karma:local']
            },
            flash: {
                files : [
                    'src/flash/com/longtailvideo/jwplayer/{,*/}*.as',
                    'src/flash/com/wowsa/{,*/}*.as'
                ],
                tasks: ['build-flash']
            },
            grunt: {
                files: ['Gruntfile.js'],
                tasks: ['jshint:grunt']
            }
        },

        connect: {
            options: {
                port: 3000,
                // change this to '0.0.0.0' to access the server from outside
                // change this to 'localhost' to restrict access to the server from outside
                hostname: 'localhost'
            },
            livereload: {
                options: {
                    open: true,
                    livereload: true,
                    base: [
                        '.'
                    ]
                }
            }
        },
        uglify: {
            options: {
                // screwIE8: true,
                compress: {
                    warnings: true
                },
                mangle: {
                    except: ['RESERVED_KEYWORDS_TO_PROTECT']
                }
            },
            release: {
                files: {
                    'bin-release/jwplayer.js': ['bin-release/jwplayer.js']
                }
            }
        },

        flash: {
            options: {
                targetCompilerOptions : [
                    '-define+=JWPLAYER::version,\'' + packageInfo.version + '\''
                ],
                // prefer AIR_HOME for faster compilation and JRE 7 64-bit support
                sdk: env.AIR_HOME || env.FLEX_HOME,
                ascshdPort: 11123
            },
            debug : {
                options : {
                    debug : true
                },
                files : {
                    'bin-debug/jwplayer.flash.swf' : 'src/flash/com/longtailvideo/jwplayer/player/Player.as'
                }
            },
            release : {
                files : {
                    'bin-release/jwplayer.flash.swf': 'src/flash/com/longtailvideo/jwplayer/player/Player.as'
                }
            },
            library: {
                options: {
                    swc: true
                },
                files : {
                     'libs-external/jwplayer.flash.swc' : 'src/flash/com/longtailvideo/jwplayer/player/Player.as'
                }
            }
        },

        karma: {
            options: {
                configFile: './test/karma/karma.conf.js',
                port: env.KARMA_PORT || 9876,
                coverageReporter: {
                    type : 'html',
                    dir: 'reports/coverage'
                },
                junitReporter: {
                    suite: '<%= grunt.task.current.target %>',
                    outputDir: 'reports/junit'
                },
                customLaunchers: require( './test/karma/browserstack-launchers' ),
                browserStack: {
                    username:  process.env.BS_USERNAME,
                    accessKey: process.env.BS_AUTHKEY,
                    name: 'Unit Tests',
                    project: 'jwplayer',
                    build: '' + (env.JOB_NAME     || 'local' ) +' '+
                                (env.BUILD_NUMBER || env.USER) +' '+
                                (env.GIT_BRANCH   || ''      ) +' '+
                                buildVersion.split('+')[0],
                    timeout: 600 // 10 min
                }
            },
            phantomjs : {
                browsers: ['PhantomJS']
            },
            chrome : {
                browsers: ['Chrome']
            },
            firefox : {
                browsers: ['Firefox']
            },
            safari : {
                browsers: ['Safari']
            },
            // browserstack_all: { browsers: Object.keys( require( './test/qunit/karma/browserstack-launchers' ) ) },
            browserstack : {
                browsers: ['chrome']
            },
            browserstack_firefox : {
                browsers: ['firefox']
            },
            browserstack_edge : {
                browsers: ['edge']
            },
            browserstack_ie11 : {
                browsers: ['ie11_windows']
            },
            browserstack_ie10 : {
                browsers: ['ie10_windows']
            },
            browserstack_ie9 : {
                browsers: ['ie9_windows']
            }
        },

        clean: {
            options: {
                force: true
            },
            dist: {
                src: [
                    'bin-debug/',
                    'bin-release/'
                ]
            }
        }
    });

    grunt.registerTask('webpack-watch', 'Spawn a webpack watch task', function() {
        var done = this.async();
        parallelWebpack.run(path.resolve('./webpack.config.js'), {
            watch: true
        }).then(done).catch(function(err) {
            grunt.log.error(err.toString());
            done(false);
        });
    });

    grunt.registerTask('webpack', 'Run webpack compiler', function() {
        var done = this.async();
        parallelWebpack.run(path.resolve('./webpack.config.js'), {}).then(function(err, res) {
            if (err) {
                grunt.log.error(err.toString());
            }
            if (res) {
                grunt.log.writeln(res.toString());
            }
            done();
        }).catch(function(err) {
            grunt.log.error(err.toString());
            done(false);
        });
    });

    grunt.registerTask('karma:local', 'karma:phantomjs');

    grunt.registerTask('karma:remote', [
        'karma:browserstack',
        'karma:browserstack_firefox',
        'karma:browserstack_ie11',
        'karma:browserstack_ie10',
        'karma:browserstack_ie9'
    ]);

    grunt.registerTask('test', [
        'karma'
    ]);

    grunt.registerTask('build-js', [
        'webpack',
        'uglify',
        'jshint:player',
        'recess'
    ]);

    grunt.registerTask('build-flash', [
        'flash:debug',
        'flash:release'
    ]);

    grunt.registerTask('build', [
        'clean',
        'build-js',
        'build-flash',
        'karma:local'
    ]);

    grunt.registerTask('serve', [
        'connect:livereload',
        'watch'
    ]);

    grunt.registerTask('default', 'build');
};
