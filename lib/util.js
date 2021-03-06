var path = require('path');
var fs = require('fs');
var zlib = require('zlib');
var iconv;
var tar;
var _ = {};

module.exports = _;

if (!log) {
    //for test
    log = require('./log.js')();
}

function getIconv() {
    if (!iconv) {
        iconv = require('iconv-lite');
    }
    return iconv;
}

function getTar() {
    if (!tar) {
        tar = require('tar');
    }
    return tar;
}

_.isUTF8 = require('is-utf8');

_.normalize = function (file) {
    return path.normalize(file); // node 0.10.*
};

_.del = function (p) {
    log.debug('_.del("%s")', p);
    var stat = fs.statSync(p);
    if (stat.isFile() || stat.isSymbolicLink()) {
        fs.unlinkSync(p);
    } else if (stat.isDirectory()) {
        fs.readdirSync(p).forEach(function (name) {
            _.del(path.join(p, name));
        });
        fs.rmdirSync(p);
    }
    return true;
};

_.hit = function (file, include, exclude) {
    return include ?
        (exclude ? include.test(file) && !exclude.test(file) : include.test(file)) :
        (exclude ? !exclude.test(file) : true);
};

_.find = function (dir, include, exclude) {
    dir = path.resolve(dir);
    if (!fs.existsSync(dir)) {
        return [];
    }
    var files = [];
    var arr = fs.readdirSync(dir);
    arr.forEach(function (file) {
        file = path.join(dir, file);
        var stat = fs.statSync(file);
        if (stat.isFile()) {
            if (_.hit(file, include, exclude)) {
                files.push(file);
            }
        } else if (stat.isDirectory()) {
            files = files.concat( _.find(file, include, exclude));
        }
    });
    return files;
};

_.mkdir = function (dir, mode) {
    if (!mode) {
        mode = 511 & (~process.umask());
    }
    if (fs.existsSync(dir)) return;
    dir = path.normalize(path);
    dir.split(path.sep).reduce(function(prev, next) {
        if (prev && !fs.existsSync(prev)) {
            fs.mkdirSync(prev, mode);
        }
        return prev + '/' + next;
    });

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, mode);
    }
};

_.read = function (file) {
    if (!fs.existsSync(file)) {
        log.warn('file is not exists.');
        return '';
    }
    var buf = fs.readFileSync(file);
    if (_.isUTF8(buf)) {
        buf = buf.toString('utf-8');
        if (buf.charCodeAt(0) === 0xFEFF) {
            buf = buf.substring(1);
        }
        return buf;
    } else {
        return getIconv().decode(buf, 'gbk');
    }
};

_.write = function (file, data, encoding, append, opt) {
    if (!fs.existsSync(file)) {
        _.mkdir(path.dirname(file));
    }
    if (encoding) {
        data = getIconv().encode(data, encoding);
    }
    if (append) {
        fs.appendFileSync(file, data, opt);
    } else {
        fs.writeFileSync(file, data, opt);
    }
};

_.isFile = function (file) {
    if (!fs.existsSync(file)) {
        return false;
    }
    var stat = fs.statSync(file);
    return stat.isFile();
};

_.move = function (from, to) {
    _.copy(from, to, null, null, true);
};

_.copy = function (from, to, include, exclude, move) {
    from = path.resolve(_.normalize(from));
    to = path.resolve(_.normalize(to));
    if (!fs.existsSync(from)) {
        log.warn(from + ' is not exists.');
        return;
    }
    var stat = fs.statSync(from);
    if (stat.isFile()) {
        if (fs.existsSync(to) && !_.isFile(to)) {
            to = path.join(to, path.basename(from));
        }
        var old = process.umask(0);
        //@TODO keep directory permissions
        _.write(to, fs.readFileSync(from), null, null, {
            mode: stat.mode
        });
        process.umask(old);

        if (move) {
            _.del(from);
        }

    } else if (stat.isDirectory()) {
        var files = _.find(from, include, exclude);
        files.forEach(function (file) {
            _.copy(file, path.join(to, file.replace(from, '')), include, exclude, move);
        });
        if (move) {
            _.del(from);
        }
    }
};

_.download = function (url, opt, cb, progress) {
    var tmp_path = path.join(_.getTempDir(), _.md5(url));
    var tmp_file_path = path.join(_.getTempDir(), 'file_' + _.md5(url));
    if (fs.existsSync(tmp_path)) {
        _.del(tmp_path);
    }
    if (fs.existsSync(tmp_file_path)) {
        _.del(tmp_file_path);
    }    
    var writer = fs.createWriteStream(tmp_file_path);

    log.debug("download %s", url);

    var http;
    if (url.indexOf('https://') === 0) {
        http = require('https');
    } else {
        http = require('http');
    }

    http.request(url, function (res) {
        var status = res.statusCode;
        var total = 0;
        var loaded = 0;

        total = res.headers[ 'content-length' ] >> 0;

        res.on('data', function (c) {
            writer.write(c);
            loaded += c.length;
            progress && progress( total ? loaded/total : 0, loaded, total);
        });

        res.on('end', function () {
            writer.close();
            if(status >= 200 && status < 300 || status === 304) {
                fs.createReadStream(tmp_file_path)
                    .pipe(zlib.createGunzip())
                    .pipe(getTar().Extract({ path : tmp_path }))
                    .on('error', cb)
                    .on('end', function () {
                        var files = fs.readdirSync(tmp_path);
                        log.debug("downloaded %s, temp_path %s", url, tmp_path);
                        cb(null, path.join(tmp_path, files[0]));
                    });
            } else {
                cb(new Error('req ' + url + ': server relay status code ' + status + '.'));
            }
        });
        res.on('error', cb);
    }).on('error', cb).end();
};

_.md5 = function (data) {
    var crypto = require('crypto');
    var md5 = crypto.createHash('md5');
    var encoding = typeof data === 'string' ? 'utf8' : 'binary';
    md5.update(data, encoding);
    return md5.digest('hex');
};

_.getTempDir = function () {
    var list = ['LOCALAPPDATA', 'APPDATA', 'HOME'];
    var tmp;
    for(var i = 0, len = list.length; i < len; i++){
        if(tmp = process.env[list[i]]){
            break;
        }
    }
    tmp = path.join(tmp, '.fis-download');

    if (!fs.existsSync(tmp)) {
        fs.mkdirSync(tmp);
    }

    return tmp;
};

_.escapeRegExp = function (str) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
};

_.fs = fs;