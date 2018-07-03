/* NodeJS-Seedlink-Stations
 *
 * NodeJS application for reading the available 
 * stations from arbitrary Seedlink servers.
 *
 * Copyright (c) Mathijs Koymans, 2018
 * Licensed under MIT.
 *
 *
 */

const Network = require("net");
const Http = require("http");
const CONFIG = require("./config");
const url = require("url");
const querystring = require("querystring");

// Global container for Stations
var GLOBAL_STATIONS = new Object(); 
const CAT_NOT_IMPLEMENTED = 232;

function validateAllowed(key) {

  /* function validateAllowed
   * Validates whether a key is allowed;
   */

  const ALLOWED_PARAMETERS = [
    "host"
  ];

  if(ALLOWED_PARAMETERS.indexOf(key) === -1) {
    throw("Key " + key + " is not supported");
  }

}

function validateParameters(queryObject) {

  if(queryObject.port < 0 || queryObject.port >= (1 << 16)) {
    throw("A submitted port is invalid");
  }

}

module.exports = function(callback) {

  function HTTPError(response, statusCode, message) {

    /* function HTTPError
     * Returns an HTTP error to client
     */

    response.writeHead(statusCode, {"Content-Type": "text/plain"});
    response.end(message)
  
  }

  // Create a HTTP server
  const Server = Http.createServer(function(request, response) {

    // Sets CORS headers
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET");

    var uri = url.parse(request.url);
    var queryObject = querystring.parse(uri.query);

    // Check if a query is submitted
    if(uri.query === null || uri.query === "") {
      return HTTPError(response, 400, "Empty query string submitted");
    }

    if(!Object.prototype.hasOwnProperty.call(queryObject, "host")) {
      return HTTPError(response, 400, "Host parameter is required");
    }

    // Only root path is supported
    if(uri.pathname !== "/") {
      return HTTPError(response, 405, "Method not supported")
    }

    // Get the comma delimited host:port values
    servers = queryObject.host.split(",").map(function(x) {
      var [host, port] = x.split(":"); 
      return {
        "url": x,
        "host": host,
        "port": port || 18000
      }
    });

    // Check user input
    try {
      Object.keys(queryObject).forEach(validateAllowed);
      servers.forEach(validateParameters);
    } catch(exception) {
      return HTTPError(response, 400, exception);
    }

    // Make queries to the servers (or read from cache)
    updateAll(servers, function(data) {
      response.end(JSON.stringify(data));
    });

  });

  // Listen to incoming HTTP connections
  Server.listen(CONFIG.PORT, CONFIG.HOST, function() {
    if(typeof callback === "function") {
      callback();
    }
  });

}

// Start the NodeJS Seedlink Server
if(require.main === module) {

  // Start up the WFCatalog
  new module.exports(function() {
    console.log("NodeJS Latency Server has been initialized on " + CONFIG.HOST + ":" + CONFIG.PORT)
  });

}

function updateAll(servers, callback) {

  var results = new Array();

  // Asynchronously but concurrently get the data
  (next = function() {
    SeedlinkChecker(servers.pop(), function(result) {
      results.push(result);
      if(!servers.length) {
        return callback(results);
      }
      next();
    });
  })();

}

function isCached(host) {

  /* function isCached
   * Returns boolean whether a seedlink server is cached
   */

  return GLOBAL_STATIONS.hasOwnProperty(host) && GLOBAL_STATIONS[host].requested > (Date.now() - CONFIG.REFRESH_INTERVAL);

}

function SeedlinkChecker(server, callback) {

  function finish(socket, host, data, callback) {
  
    GLOBAL_STATIONS[host] = data;
    socket.destroy();
    callback(data);
  
  }

  /* Function SeedlinkChecker
   * Checks if Seedlink is present
   * Returns all metadata: networks, stations, sites
   */

  // Constants
  const CRNL = "\r\n";
  const CAT_COMMAND = "CAT" + CRNL;
  const HELLO_COMMAND = "HELLO" + CRNL;

  var url = server.url;

  // If the host is in the cache
  if(isCached(url)) {
    return callback(GLOBAL_STATIONS[url]);
  }

  // Metadata for the request
  var requestData = {
    "host": url,
    "stations": new Array(),
    "error": null,
    "version": null,
    "identifier": null,
    "connected": false,
    "requested": Date.now()
  }

  // Create a new TCP socket and empty buffer
  var socket = new Network.Socket()
  var buffer = new Buffer(0);

  // Set Timout in milliseconds
  socket.setTimeout(CONFIG.SOCKET.TIMEOUT);

  socket.on("error", function() {
    requestData.error = "ECONNREFUSED";
    finish(socket, url, requestData, callback);
  });

  socket.on("timeout", function() {
    requestData.error = "ECONNREFUSED";
    finish(socket, url, requestData, callback);
  });

  // When the connection is established write HELLO
  socket.connect(server.port, server.host, function() {
    socket.write(HELLO_COMMAND);
  });

  // Data is written over the socket
  socket.on("data", function(data) {

    requestData.connected = true;

    // Extend the buffer with new data
    buffer = Buffer.concat([buffer, data]);

    // Get the Seedlink version
    if(requestData.version === null && buffer.toString().split(CRNL).length === 3) {

      // Extract the version
      var [version, identifier] = buffer.toString().split(CRNL);

      requestData.version = version;
      requestData.identifier = identifier;

      // Reset the buffer for the next request
      buffer = new Buffer(0);

      // Proceed with the CAT command
      return socket.write(CAT_COMMAND);

    }

    // If the command was not implemented (e.g. IRIS ringserver)
    if(buffer.toString() === "CAT command not implemented" + CRNL) {
      requestData.error = "CATNOTIMPLEMENTED";
      finish(socket, url, requestData, callback);
    }

    // End of the response
    if(buffer.lastIndexOf("\nEND") === buffer.length - 4) {
      requestData.stations = parseBuffer(buffer);
      finish(socket, url, requestData, callback);
    }

  });

}

function parseBuffer(buffer) {

  /* function parseBuffer
   * Extracts network, station information from Seedlink CAT response
   */

  // Cut off the END
  buffer = buffer.slice(0, buffer.lastIndexOf("\nEND"));

  // Split by line and map result
  return buffer.toString().split("\n").map(function(x) {
    return {
      "network": x.slice(0, 2).trim(),
      "station": x.slice(3, 8).trim(),
      "site": x.slice(9, x.length).trim()
    }
  });

}