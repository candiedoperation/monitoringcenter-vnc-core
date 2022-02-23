const express = require('express')
const app = express()
const port = 3001
const Routes = require('./routes/index');

app.get('/', Routes.rootRoute);
app.post('/ping', Routes.pingRoute.pingRoutePost)

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
