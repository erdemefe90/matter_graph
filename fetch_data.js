const WebSocket = require('ws');
const fs = require('fs');

const ws = new WebSocket('ws://homeassistant.local:5580/ws');

ws.on('open', function open() {
  console.log('Connected');
  const command = {
    message_id: "1",
    command: "start_listening",
    args: {}
  };
  ws.send(JSON.stringify(command));
});

ws.on('message', function incoming(data) {
  const response = JSON.parse(data);
  console.log('Received data');
  
  if (response.message_id === "1" && response.result) {
    fs.writeFileSync('nodes_dump.json', JSON.stringify(response.result, null, 2));
    console.log('Data written to nodes_dump.json');
    ws.close();
  }
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});
