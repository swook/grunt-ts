/// <reference path="../../defs/tsd.d.ts"/>
/// <reference path="./interfaces.d.ts"/>
var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var fs = require('fs');
var path = require('path');
var grunt = require('grunt');
var _str = require('underscore.string');
var _ = require('lodash');
var os = require('os');
var utils = require('./utils');

// Setup when transformers are triggered
var currentTargetFiles;
var currentTargetDirs;

// Based on name
// if a filename matches we return a filepath
// If a foldername matches we return a folderpath
function getImports(currentFilePath, name, targetFiles, targetDirs, getIndexIfDir) {
    if (typeof getIndexIfDir === "undefined") { getIndexIfDir = true; }
    var files = [];

    // Test if any filename matches
    var targetFile = _.find(targetFiles, function (targetFile) {
        return path.basename(targetFile) === name || path.basename(targetFile, '.d.ts') === name || path.basename(targetFile, '.ts') === name;
    });
    if (targetFile) {
        files.push(targetFile);
    }

    // It might be worthwhile to cache this lookup
    // i.e. have a 'foldername':folderpath map passed in
    // Test if dirname matches
    var targetDir = _.find(targetDirs, function (targetDir) {
        return path.basename(targetDir) === name;
    });
    if (targetDir) {
        var possibleIndexFilePath = path.join(targetDir, 'index.ts');

        // If targetDir has an index file AND this is not that file then
        // use index.ts instead of all the files in the directory
        if (getIndexIfDir && fs.existsSync(possibleIndexFilePath) && path.relative(currentFilePath, possibleIndexFilePath) !== '') {
            files.push(path.join(targetDir, 'index.ts'));
        } else {
            var filesInDir = utils.getFiles(targetDir, function (filename) {
                // exclude current file
                if (path.relative(currentFilePath, filename) === '') {
                    return true;
                }

                return path.extname(filename) && (!_str.endsWith(filename, '.ts') || _str.endsWith(filename, '.d.ts')) && !fs.lstatSync(filename).isDirectory();
            });
            filesInDir.sort(); // Sort needed to increase reliability of codegen between runs
            files = files.concat(filesInDir);
        }
    }

    return files;
}

// Algo
// Notice that the file globs come as
// test/fail/ts/deep/work.ts
// So simply get dirname recursively till reach root '.'
function getTargetFolders(targetFiles) {
    var folders = {};
    _.forEach(targetFiles, function (targetFile) {
        var dir = path.dirname(targetFile);
        while (dir !== '.' && !(dir in folders)) {
            // grunt.log.writeln(dir);
            folders[dir] = true;
            dir = path.dirname(dir);
        }
    });
    return Object.keys(folders);
}

var BaseTransformer = (function () {
    function BaseTransformer(key, variableSyntax) {
        this.key = key;
        this.match = new RegExp(utils.format(BaseTransformer.tsTransformerMatch, key));
        this.signature = '///ts:' + key;
        this.signatureGenerated = this.signature + ':generated';
        this.syntaxError = '/// Invalid syntax for ts:' + this.key + '=' + variableSyntax + ' ' + this.signatureGenerated;
    }
    BaseTransformer.prototype.isGenerated = function (line) {
        return _str.contains(line, this.signatureGenerated);
    };

    BaseTransformer.prototype.matches = function (line) {
        return line.match(this.match);
    };

    BaseTransformer.containsTransformSignature = function (line) {
        return BaseTransformer.tsSignatureMatch.test(line);
    };
    BaseTransformer.tsSignatureMatch = /\/\/\/\s*ts\:/;

    BaseTransformer.tsTransformerMatch = '^///\\s*ts:{0}(=?)(.*)';
    return BaseTransformer;
})();

// This is a separate class from BaseTransformer to make it easier to add non import/export transforms in the future
var BaseImportExportTransformer = (function (_super) {
    __extends(BaseImportExportTransformer, _super);
    function BaseImportExportTransformer(key, variableSyntax, template, getIndexIfDir, removeExtensionFromFilePath) {
        _super.call(this, key, variableSyntax);
        this.key = key;
        this.template = template;
        this.getIndexIfDir = getIndexIfDir;
        this.removeExtensionFromFilePath = removeExtensionFromFilePath;
    }
    BaseImportExportTransformer.prototype.transform = function (sourceFile, templateVars) {
        var _this = this;
        var result = [];
        if (templateVars) {
            var vars = templateVars.split(',');
            var requestedFileName = vars[0].trim();
            var requestedVariableName = (vars.length > 1 ? vars[1].trim() : null);
            var sourceFileDirectory = path.dirname(sourceFile);
            var imports = getImports(sourceFile, requestedFileName, currentTargetFiles, currentTargetDirs, this.getIndexIfDir);
            if (imports.length) {
                _.forEach(imports, function (completePathToFile) {
                    var filename = requestedVariableName || path.basename(path.basename(completePathToFile, '.ts'), '.d');

                    // If filename is index, we replace it with dirname:
                    if (filename.toLowerCase() === 'index') {
                        filename = path.basename(path.dirname(completePathToFile));
                    }
                    var pathToFile = utils.makeRelativePath(sourceFileDirectory, _this.removeExtensionFromFilePath ? completePathToFile.replace(/(?:\.d)?\.ts$/, '') : completePathToFile, true);
                    result.push(_this.template({ filename: filename, pathToFile: pathToFile, signatureGenerated: _this.signatureGenerated }) + ' ' + _this.signatureGenerated);
                });
            } else {
                result.push('/// No file or directory matched name "' + requestedFileName + '" ' + this.signatureGenerated);
            }
        } else {
            result.push(this.syntaxError);
        }
        return result;
    };
    return BaseImportExportTransformer;
})(BaseTransformer);

var ImportTransformer = (function (_super) {
    __extends(ImportTransformer, _super);
    function ImportTransformer() {
        _super.call(this, 'import', '<fileOrDirectoryName>[,<variableName>]', _.template('import <%=filename%> = require(\'<%= pathToFile %>\');'), true, true);
    }
    return ImportTransformer;
})(BaseImportExportTransformer);

var ExportTransformer = (function (_super) {
    __extends(ExportTransformer, _super);
    function ExportTransformer() {
        // This code is same as import transformer
        // One difference : we do not short circuit to `index.ts` if found
        _super.call(this, 'export', '<fileOrDirectoryName>[,<variableName>]', _.template('import <%=filename%>_file = require(\'<%= pathToFile %>\'); <%= signatureGenerated %>' + os.EOL + 'export var <%=filename%> = <%=filename%>_file;'), false, true);
    }
    return ExportTransformer;
})(BaseImportExportTransformer);

var ReferenceTransformer = (function (_super) {
    __extends(ReferenceTransformer, _super);
    function ReferenceTransformer() {
        // This code is same as export transformer
        // also we preserve .ts file extension
        _super.call(this, 'ref', '<fileOrDirectoryName>', _.template('/// <reference path="<%= pathToFile %>"/>'), false, false);
    }
    return ReferenceTransformer;
})(BaseImportExportTransformer);

var UnknownTransformer = (function (_super) {
    __extends(UnknownTransformer, _super);
    function UnknownTransformer() {
        _super.call(this, '(.*)', '');
        this.key = 'unknown';
        this.signatureGenerated = '///ts:unknown:generated';
        this.syntaxError = '/// Unknown transform ' + this.signatureGenerated;
    }
    UnknownTransformer.prototype.transform = function (sourceFile, templateVars) {
        return [this.syntaxError];
    };
    return UnknownTransformer;
})(BaseTransformer);

// This code fixes the line encoding to be per os.
// I think it is the best option available at the moment.
// I am open for suggestions
function transformFiles(changedFiles, targetFiles, target, task) {
    currentTargetDirs = getTargetFolders(targetFiles);
    currentTargetFiles = targetFiles;

    ///////////////////////////////////// transformation
    var transformers = [
        new ImportTransformer(),
        new ExportTransformer(),
        new ReferenceTransformer(),
        new UnknownTransformer()
    ];

    _.forEach(changedFiles, function (fileToProcess) {
        var contents = fs.readFileSync(fileToProcess).toString().replace(/^\uFEFF/, '');

        // If no signature don't bother with this file
        if (!BaseTransformer.containsTransformSignature(contents)) {
            return;
        }

        var lines = contents.split(/\r\n|\r|\n/);
        var outputLines = [];

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            //// Debugging
            // grunt.log.writeln('line'.green);
            // grunt.log.writeln(line);
            // Skip generated lines as these will get regenerated
            if (_.some(transformers, function (transformer) {
                return transformer.isGenerated(line);
            })) {
                continue;
            }

            // Directive line
            if (_.some(transformers, function (transformer) {
                var match = transformer.matches(line);
                if (match) {
                    // The code gen directive line automatically qualifies
                    outputLines.push(line);

                    // pass transform settings to transform (match[1] is the equals sign, ensure it exists but otherwise ignore it)
                    outputLines.push.apply(outputLines, transformer.transform(fileToProcess, match[1] && match[2] && match[2].trim()));
                    return true;
                }
                return false;
            })) {
                continue;
            }

            // Lines not generated or not directives
            outputLines.push(line);
        }
        var transformedContent = outputLines.join(os.EOL);
        if (transformedContent !== contents) {
            grunt.file.write(fileToProcess, transformedContent);
        }
    });
}
exports.transformFiles = transformFiles;
//# sourceMappingURL=transformers.js.map
