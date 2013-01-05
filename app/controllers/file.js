
var debug       = require('debug')('express-chat')
  , GrowingFile = require('growing-mongofile');

module.exports = function(app, model) {

    var FileModel     = model.mongoose.model('File')
      , MessageModel  = model.mongoose.model('Message')
      , IPModel       = model.mongoose.model('IP')
      , db            = model.mongo
      , retryAsync    = app.libs.util.retryAsync
      , Step          = app.libs.Step;

    var actions       = {};

    var MAX_SIMUL_UP      = app.config.limits.maxSimulUp;
    var MAX_UP_MB         = app.config.limits.maxUpMB;
    var UP_TARGET_KBs     = app.config.limits.uploadSpeedKBs;
    var DOWN_TARGET_KBs   = app.config.limits.downloadSpeedKBs;

    var chatIOUrl     = app.routes.io("chat.socket");
    var fileIOUrl     = app.routes.io("file.socket");

    actions.upload = function(req, res, error) {
        var roomid    = req.params.roomid
          , filesize  = req.form.fileInfo.filesize
          , filename  = req.form.fileInfo.filename;
        
        if(typeof roomid !== "string" || roomid.length > 16) {
            error('Invalid Room ID');
            return;
        }

        if(typeof filename !== "string" || filename.length > 255 || /\\|\/|:|<|>/.test(filename)) {
            error(new Error('Invalid Filename'));
            return;
        }
        
        // we store the username in the socket object
        // and the socket ids (one for each room) in the session
        if(!req.session.rooms || !req.session.rooms[roomid]) {
            error(new Error('User is not connected!'));
            return;
        }

        var username = req.session.rooms[roomid].username;

        if(!username) {
            error(new Error("client's name not found"));
            return;
        }
        
        Step(
            function loadIP() {
                var nextstep = this;
                IPModel.load(req, function(err, ip) {
                    if(err || !ip) {
                        error(err);
                    } else if(ip.canUpload(filesize)) {
                        nextstep(null, ip);
                    } else {
                        error(new Error("Upload limit exceeded"));
                    }
                });
            },
            function createFile(err, ip) {
                if(err) throw err;
                
                var nextstep = this;
                var file = new FileModel({
                    originalname  : filename
                  , uploaderip    : ip.ip
                  , uploadername  : username
                  , size          : filesize
                });
                file.save(function(err) {
                    if(err) {
                        error(err);
                        return;
                    }
                    nextstep(null, ip, file);
                });
            },
            function createGridStore(err, ip, file) {
                if(err) throw err;
                
                var nextstep = this;
                var servername = file.servername;
                var meta = {filesize: filesize, originalname: file.originalname};
                var gs = GrowingFile.createGridStore(app.libs.mongodb, db, servername, meta, function(err, gs) {
                    if(err || !gs) {
                        error(new Error('Error creating gridstore : '+(err && err.message)));
                        return;
                    }
                    nextstep(null, file);
                });
                
                req.form.speedTarget = UP_TARGET_KBs;

                var fileStatus = {
                    servername  : servername,
                    status      : file.status,
                    percent     : 0
                };
                
                ip.newUpload();
                
                function transferOver(err) {
                    ip.uploadFinished();
                    fileStatus.status = file.status;
                    app.io.of(fileIOUrl).in(servername).emit('status', fileStatus);
                }

                var totalRead = 0;
                req.form.onChunk = function(data, callback) {
                    gs.write(data, function() {
                        totalRead += data.length;
                        var newProgress = Math.floor(100*totalRead/file.size);
                        if(newProgress > fileStatus.percent) {
                            fileStatus.percent = newProgress;
                            app.io.of(fileIOUrl).in(servername).emit('status', fileStatus);
                        }
                        ip.addUploaded(data.length);
                        callback();
                    });
                };
                
                req.form.on('close', function() {
                    gs.close(function(err, result) {
                        file.status = "Available";
                        file.save();
                        transferOver();
                    });
                });

                req.form.on('error', function(err) {
                    console.log(err);
                    file.status = "Removed";
                    file.save();
                    transferOver(err);
                });

                req.form.on('aborted', function() {
                    gs.unlink(function(err) {
                        file.status = "Removed";
                        file.save();
                        transferOver(err);
                    });
                });
            },
            function start(err, file) {
                if(err) throw err;
                
                var nextstep = this;
                req.form.read();
                debug("uploading "+file.originalname+ " (size : "+file.size+")");
                nextstep(null, file);
            },
            function saveMessageFile(err, file) {
                if(err) throw err;
                
                var nextstep = this;
                var message = MessageModel.createEmptyFileMessage(roomid, file);
                message.save(function(err) {
                    if(err) {
                        error(err);
                        return;
                    }
                    var msg = message.publicFields();
                    msg.attachment = file.publicFields();
                    app.io.of(chatIOUrl).in(roomid).json.emit("new message", msg);
                });
            },
            function handleError(err) {
                console.log(err.stack);
                if(err) error(err);
            }
        );
        
    };
    

    actions.download = function(req, res, error) {
        var servername = req.params.servername;
        var filenameRequested = req.params.filename;
        
        if(typeof servername !== "string" || servername.length > 16) {
            error('Invalid file ID');
            return;
        }
        
        Step(
            //TODO: find a server which has the file instead of polling
            function findFile() {
                var nextstep = this;
                retryAsync(function() {
                    var retry = this;
                    FileModel.findOne({servername: servername}, function(err, file) {
                        if(err || !file) {
                            setTimeout(retry, 2000);
                            return;
                        }
                        if(file.status == 'Removed') {
                            error(new Error("File has been removed !"));
                            return;
                        }
                        if(file.originalname != filenameRequested) {
                            error(new Error("File Not found !"));
                            return;
                        }
                        nextstep(null, file);
                    });
                }, 5, function() {
                    error(err || new Error('File not found'));
                });
            },
            function loadIP(err, file) {
                if(err) throw err;
                
                var nextstep = this;
                IPModel.load(req, function(err, ip) {
                    if(ip && ip.canDownload(file.size)) {
                        nextstep(err, ip);
                    } else {
                        error(new Error("Download limit exceeded"));
                    }
                });
            },
            function openFile(err, ip) {
                if(err) throw err;
                
                var nextstep = this;
                retryAsync(function() {
                    var retry = this;
                    GrowingFile.open(app.libs.mongodb, db, servername, null, function(err, gf) {
                        if(err || !gf) {
                            setTimeout(retry, 2000);
                            return;
                        }
                        nextstep(null, gf, ip);
                    });
                }, 5, function() {
                    error(err || new Error('GrowingFile not found'));
                });
            },
            function sendFile(err, gf, ip) {
                if(err) throw err;
                
                var filename = gf.originalname;
                var filesize = gf.filesize;
                debug("downloading "+filename+ " (size : "+filesize+")");
                res.contentType(filename);
                res.header('Content-Length', filesize);
                gf.pipe(res);
                ip.newDownload();
                ip.addDownloaded(filesize);
                gf.on('end', function() {
                    ip.downloadFinished();
                });
                gf.on('error', function() {
                    ip.downloadFinished();
                });
            }
        );
        
    };

    actions.socket = function(socket) {
        var hs      = socket.handshake
          , sroomid = null;
        
        socket.on('user register', function(roomid, callback) {
            if(typeof callback !== "function") {
                return;
            }
            if(typeof roomid !== "string" || roomid.length > 64) {
                callback('roomid invalid');
                return;
            }
            if(!hs.session) {
                callback('session expired');
                return;
            }
            sroomid = roomid;
            callback();
        });

        socket.on('file watch', function(servername) {
            if(typeof servername != "string" || servername.length > 64) {
                return;
            }
            FileModel
            .findOne({'servername': servername})
            .exec(function(err, file) {
                if(err || !file) {
                    return;
                }
                if(file.status == 'Uploading') {
                    socket.join(servername);
                } else {
                    socket.emit("status", file.publicFields());
                }
            });
        });

        socket.on('file unwatch', function(servername) {
            if(typeof servername != "string" || servername.length > 64) {
                return;
            }
            socket.leave(servername);
        });

    };

    return actions;
    
}
