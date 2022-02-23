/*
    A WebSocket to TCP socket proxy
    Copyright 2012 Joel Martin
    Licensed under LGPL version 3 (see docs/LICENSE.LGPL-3)

    websocketTcp.js (for Monitoring Center)
    HTTP Authentication implemented by Atheesh Thirumalairajan
    Copyright 2022 Atheesh Thirumalairajan
*/

const cliArgs = require('optimist').argv;
const net = require('net');
const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

const Buffer = require('buffer').Buffer
const WebSocketServer = require('ws').Server

var webServer, wss,
source_host, source_port, target_host, target_port,
web_path = null;

// Handle new WebSocket client
joinAuthenticatedClient = function(client, req) {
    var clientAddr = client._socket.remoteAddress, log;
    var start_time = new Date().getTime();

    console.log(req ? req.url : client.upgradeReq.url);
    log = function (msg) {
        console.log(' ' + clientAddr + ': '+ msg);
    };

    log('WebSocket connection');
    log('Version ' + client.protocolVersion + ', subprotocol: ' + client.protocol);

    if (cliArgs.record) {
      var rs = fs.createWriteStream(cliArgs.record + '/' + new Date().toISOString().replace(/:/g, "_"));
      rs.write('var VNC_frame_data = [\n');
    } else {
      var rs = null;
    }

    var target = net.createConnection(target_port,target_host, function() {
        log('Connected to Target');
    });

    target.on('data', function(data) {
        //log("sending message: " + data);

        if (rs) {
          var tdelta = Math.floor(new Date().getTime()) - start_time;
          var rsdata = '\'{' + tdelta + '{' + decodeBuffer(data) + '\',\n';
          rs.write(rsdata);
        }

        try {
            client.send(data);
        } catch(e) {
            log("Client closed, cleaning up target");
            target.end();
        }
    });

    target.on('end', function() {
        log('target disconnected');
        client.close();
        if (rs) {
          rs.end('\'EOF\'];\n');
        }
    });

    target.on('error', function() {
        log('target connection error');
        target.end();
        client.close();
        if (rs) {
          rs.end('\'EOF\'];\n');
        }
    });

    client.on('message', function(msg) {
        //log('got message: ' + msg);

        if (rs) {
          var rdelta = Math.floor(new Date().getTime()) - start_time;
          var rsdata = ('\'}' + rdelta + '}' + decodeBuffer(msg) + '\',\n');
          rs.write(rsdata);
        }

        target.write(msg);
    });
    client.on('close', function(code, reason) {
        log('WebSocket client disconnected: ' + code + ' [' + reason + ']');
        target.end();
    });
    client.on('error', function(a) {
        log('WebSocket client error: ' + a);
        target.end();
    });
};

function decodeBuffer(buf) {
  var returnString = '';
  for (var i = 0; i < buf.length; i++) {
    if (buf[i] >= 48 && buf[i] <= 90) {
      returnString += String.fromCharCode(buf[i]);
    } else if (buf[i] === 95) {
      returnString += String.fromCharCode(buf[i]);
    } else if (buf[i] >= 97 && buf[i] <= 122) {
      returnString += String.fromCharCode(buf[i]);
    } else {
      var charToConvert = buf[i].toString(16);
      if (charToConvert.length === 0) {
        returnString += '\\x00';
      } else if (charToConvert.length === 1) {
        returnString += '\\x0' + charToConvert;
      } else {
        returnString += '\\x' + charToConvert;
      }
    }
  }
  return returnString;
}

// Send an HTTP error response
http_error = function (response, code, msg) {
    response.writeHead(code, {"Content-Type": "text/plain"});
    response.write(msg + "\n");
    response.end();
    return;
}

// Process an HTTP static file request
http_request = function (request, response) {
//    console.log("pathname: " + url.parse(req.url).pathname);
//    res.writeHead(200, {'Content-Type': 'text/plain'});
//    res.end('okay');

    if (! cliArgs.web) {
        return http_error(response, 403, "403 Permission Denied");
    }

    var uri = url.parse(request.url).pathname
        , filename = path.join(cliArgs.web, uri);

    fs.exists(filename, function(exists) {
        if(!exists) {
            return http_error(response, 404, "404 Not Found");
        }

        if (fs.statSync(filename).isDirectory()) {
            filename += '/index.html';
        }

        fs.readFile(filename, "binary", function(err, file) {
            if(err) {
                return http_error(response, 500, err);
            }

            var headers = {};
            var contentType = mime.contentType(path.extname(filename));
            if (contentType !== false) {
              headers['Content-Type'] = contentType;
            }

            response.writeHead(200, headers);
            response.write(file, "binary");
            response.end();
        });
    });
};

// parse source and target arguments into parts
try {
    source_arg = cliArgs._[0].toString();
    target_arg = cliArgs._[1].toString();

    var idx;
    idx = source_arg.indexOf(":");
    if (idx >= 0) {
        source_host = source_arg.slice(0, idx);
        source_port = parseInt(source_arg.slice(idx+1), 10);
    } else {
        source_host = "";
        source_port = parseInt(source_arg, 10);
    }

    idx = target_arg.indexOf(":");
    if (idx < 0) {
        throw("target must be host:port");
    }
    target_host = target_arg.slice(0, idx);
    target_port = parseInt(target_arg.slice(idx+1), 10);

    if (isNaN(source_port) || isNaN(target_port)) {
        throw("illegal port");
    }
} catch(e) {
    console.error("websocketTcp.js [--web web_dir] [--cert cert.pem [--key key.pem]] [--record dir] [source_addr:]source_port target_addr:target_port");
    process.exit(2);
}

console.log("WebSocket settings: ");
console.log("    - proxying from " + source_host + ":" + source_port +
            " to " + target_host + ":" + target_port);
if (cliArgs.web) {
    console.log("    - Web server active. Serving: " + cliArgs.web);
}

if (cliArgs.cert) {
    cliArgs.key = cliArgs.key || cliArgs.cert;
    var cert = fs.readFileSync(cliArgs.cert),
        key = fs.readFileSync(cliArgs.key);
    console.log("    - Running in encrypted HTTPS (wss://) mode using: " + cliArgs.cert + ", " + cliArgs.key);
    webServer = https.createServer({cert: cert, key: key}, http_request);
} else {
    console.log("    - Running in unencrypted HTTP (ws://) mode");
    webServer = http.createServer(http_request);
}

wss = new WebSocketServer({ noServer: true });
wss.on('connection', joinAuthenticatedClient);

webServer.on('upgrade', function upgrade(request, socket, head) {
  function authenticate(authRequest, nextFunction) {
      nextFunction();
  }
  // This function is not defined on purpose. Implement it with your own logic.
  authenticate(request, function next(err) {
    if (err) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  });
});

webServer.listen(source_port);